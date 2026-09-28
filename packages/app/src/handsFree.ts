/** Foreground, turn-taking voice ownership. Native bindings live in ui/useHandsFree. */
export type HandsFreeState = "off" | "starting" | "listening" | "pending-send" | "finalising" | "waiting" | "speaking" | "paused";

export interface HandsFreeContext {
  sessionId?: string;
  contextKey: string;
  foreground: boolean;
  online: boolean;
  live: boolean;
  busy: boolean;
  loading: boolean;
  permission: boolean;
  interruption?: string;
  voiceEnabled: boolean;
  speaking: boolean;
  manualRecording: boolean;
  draft: string;
  draftVersion: number;
  attachments: number;
}

export interface HandsFreeEffects {
  read(): HandsFreeContext;
  start(ticket: number): Promise<boolean>;
  finish(): void;
  cancel(): void;
  stopPlayback(): void;
  send(sessionId: string, draftVersion: number): boolean;
  changed(): void;
}

export interface HandsFreeClock {
  after(ms: number, callback: () => void): () => void;
}

const defaultClock: HandsFreeClock = {
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

export class HandsFreeLoop {
  state: HandsFreeState = "off";
  reason = "";
  private generation = 0;
  private sessionId?: string;
  private contextKey = "";
  private draftVersion = 0;
  private deadline?: () => void;
  private emptyDeadline?: () => void;
  private replyId?: string;
  private readonly seenReplies = new Set<string>();

  constructor(private readonly effects: HandsFreeEffects, private readonly clock: HandsFreeClock = defaultClock) {}

  get enabled(): boolean { return this.state !== "off"; }
  get active(): boolean { return this.enabled && this.state !== "paused"; }
  get ticket(): number { return this.generation; }

  current(ticket: number): boolean { return this.active && ticket === this.generation; }

  /** Check BEFORE a native result is allowed to replace the composer draft. */
  captureCurrent(ticket: number): boolean { return this.check(ticket); }

  canSend(sessionId: string, version: number): boolean {
    const context = this.effects.read();
    return this.state === "waiting" && sessionId === this.sessionId &&
      !this.guard(true, false) && version === this.draftVersion &&
      version === context.draftVersion && !!context.draft.trim() && !context.speaking;
  }

  unavailable(): string | undefined {
    const context = this.effects.read();
    return this.blocked(context, true) ||
      (context.manualRecording ? "Stop manual dictation first." : undefined) ||
      (context.speaking ? "Wait for speech to finish." : undefined) ||
      (context.draft.trim() ? "Send or clear your draft first." : undefined);
  }

  enable(): void {
    const reason = this.unavailable();
    if (reason) { this.reason = reason; this.effects.changed(); return; }
    const context = this.effects.read();
    this.sessionId = context.sessionId;
    this.contextKey = context.contextKey;
    this.begin();
  }

  off(): void { this.halt("off", ""); }
  pause(reason = "Paused. Resume when ready."): void {
    if (this.active) this.halt("paused", reason);
  }
  dispose(): void { this.off(); }

  /** Called on context changes, and synchronously again at every transition. */
  reconcile(): void {
    if (!this.active) return;
    const reason = this.guard(this.state !== "waiting" && this.state !== "speaking");
    if (reason) this.pause(reason);
  }

  nativeStarted(ticket: number): void {
    if (!this.current(ticket) || this.state !== "starting") return;
    const reason = this.guard(true);
    if (reason) { this.pause(reason); return; }
    this.deadline?.();
    this.deadline = undefined;
    this.transition("listening");
    this.emptyDeadline = this.clock.after(30_000, () => {
      if (this.current(ticket)) this.pause("No speech heard. Resume when ready.");
    });
  }

  transcript(ticket: number, utterance: string): void {
    if (!this.current(ticket) || !["listening", "pending-send", "finalising"].includes(this.state)) return;
    const reason = this.guard(true, false);
    if (reason) { this.pause(reason); return; }
    const context = this.effects.read();
    this.draftVersion = context.draftVersion;
    if (utterance.trim().toLowerCase().replace(/[.!?]+$/, "") === "stop listening") {
      this.off();
      return;
    }
    if (this.state === "finalising") return; // Retain final revisions, never send from isFinal.
    this.deadline?.();
    this.deadline = undefined;
    this.transition("listening");
    if (!context.draft.trim()) return;
    this.emptyDeadline?.();
    this.emptyDeadline = undefined;
    // simplification: transcript inactivity is not acoustic silence; recogniser
    // latency is the ceiling. Upgrade to verified VAD before reducing this delay.
    this.deadline = this.clock.after(2_000, () => {
      if (!this.check(ticket)) return;
      this.transition("pending-send");
      this.deadline = this.clock.after(3_000, () => {
        if (!this.check(ticket)) return;
        this.transition("finalising");
        this.deadline = this.clock.after(3_000, () => {
          if (this.current(ticket)) this.pause("Recognition did not finish. Your draft is kept.");
        });
        try { this.effects.finish(); } catch { this.failed(ticket); }
      });
    });
  }

  nativeEnded(ticket: number): void {
    if (!this.current(ticket)) return;
    if (this.state === "waiting" || this.state === "speaking") return;
    if (this.state !== "finalising") {
      this.pause("Recognition ended before sending. Your draft is kept.");
      return;
    }
    if (!this.check(ticket)) return;
    if (!this.effects.read().draft.trim()) { this.pause("Nothing to send."); return; }
    this.clearTimers();
    // Claim the send before calling out: duplicate native end events cannot resend.
    this.transition("waiting");
    try {
      if (!this.effects.send(this.sessionId!, this.draftVersion)) this.pause("Not sent. Your draft is kept.");
    } catch { this.pause("Not sent. Your draft is kept."); }
  }

  failed(ticket: number): void {
    if (this.current(ticket)) this.pause("Voice was interrupted. Your draft is kept.");
  }

  /** Live completions only. Return false to suppress automatic audio while owned. */
  completion(turn: { id: string; sessionId: string; text: string }): boolean {
    if (!this.active || this.state !== "waiting" || turn.sessionId !== this.sessionId || this.seenReplies.has(turn.id)) return false;
    const reason = this.guard(false, false);
    if (reason) { this.pause(reason); return false; }
    this.seenReplies.add(turn.id);
    if (this.seenReplies.size > 64) this.seenReplies.delete(this.seenReplies.values().next().value!);
    if (!turn.text.trim()) { this.pause("No spoken reply received. Check the conversation."); return false; }
    this.replyId = turn.id;
    this.transition("speaking");
    return true;
  }

  playbackEnded(ticket: number, id: string, sessionId: string, outcome: "done" | "stopped" | "error"): void {
    if (!this.current(ticket) || this.state !== "speaking" || id !== this.replyId || sessionId !== this.sessionId) return;
    if (outcome !== "done") { this.pause("Speech was interrupted. Resume when ready."); return; }
    const reason = this.guard(true, false);
    if (reason) { this.pause(reason); return; }
    if (this.effects.read().draft.trim()) { this.pause("A draft is waiting. Send or clear it first."); return; }
    this.begin();
  }

  private begin(): void {
    this.clearTimers();
    const ticket = ++this.generation;
    this.draftVersion = this.effects.read().draftVersion;
    this.replyId = undefined;
    this.transition("starting");
    this.deadline = this.clock.after(30_000, () => {
      if (this.current(ticket)) this.pause("Microphone did not start. Resume when ready.");
    });
    try {
      void this.effects.start(ticket).then((started) => {
        if (!started) this.failed(ticket);
      }, () => this.failed(ticket));
    } catch { this.failed(ticket); }
  }

  private blocked(context: HandsFreeContext, idle: boolean): string | undefined {
    if (context.interruption) return context.interruption;
    if (!context.foreground) return "Keep the app open. Resume when ready.";
    if (!context.online) return "Connection lost. Resume when online.";
    if (!context.sessionId || !context.live) return "Open a live conversation first.";
    if (context.permission) return "Approval needs your attention. Resume afterwards.";
    if (context.loading || (idle && context.busy)) return "Wait for the conversation to finish loading or working.";
    if (!context.voiceEnabled) return "Enable spoken replies first.";
    if (context.attachments) return "Send or remove attachments first.";
    return undefined;
  }

  private guard(idle: boolean, draft = true): string | undefined {
    const context = this.effects.read();
    if (context.sessionId !== this.sessionId || context.contextKey !== this.contextKey) return "Conversation changed. Resume deliberately.";
    return this.blocked(context, idle) ||
      (draft && ["starting", "listening", "pending-send", "finalising"].includes(this.state) && context.draftVersion !== this.draftVersion
        ? "Draft changed. Automatic send cancelled." : undefined);
  }

  private check(ticket: number): boolean {
    if (!this.current(ticket)) return false;
    const reason = this.guard(true);
    if (reason) { this.pause(reason); return false; }
    return true;
  }

  private clearTimers(): void {
    this.deadline?.(); this.emptyDeadline?.();
    this.deadline = this.emptyDeadline = undefined;
  }

  private halt(state: "off" | "paused", reason: string): void {
    const owned = this.active;
    ++this.generation;
    this.clearTimers();
    this.state = state;
    this.reason = reason;
    this.replyId = undefined;
    if (owned) { this.effects.cancel(); this.effects.stopPlayback(); }
    this.effects.changed();
  }

  private transition(state: HandsFreeState): void {
    if (this.state === state && !this.reason) return;
    this.state = state;
    this.reason = "";
    this.effects.changed();
  }
}
