import MarkdownIt from "markdown-it";

/** Matches the notification buffer: a cue only ever needs the opening line. */
export const SPOKEN_INPUT_LIMIT = 2000;
export const CUE_LIMIT = 120;
const markdown = new MarkdownIt({ html: false, linkify: false });

/**
 * A pointer, not a reading: "<who>: <first sentence>. On screen." The user is
 * out and about and wants to know a step finished, not hear the whole answer.
 * Parse Markdown so fenced/indented code and link targets stay silent.
 */
export function spokenCue(text: string | undefined, label?: string): string {
  const parts: string[] = [];
  for (const block of markdown.parse((text ?? "").slice(0, SPOKEN_INPUT_LIMIT), {})) {
    if (block.type !== "inline") continue;
    for (const token of block.children ?? []) {
      if (token.type === "text" || token.type === "code_inline") parts.push(token.content);
      if (token.type === "softbreak" || token.type === "hardbreak") parts.push(" ");
    }
    parts.push(" ");
  }
  const prose = parts.join("")
    .replace(/(?:\b[a-z][a-z\d+.-]*:\/\/|\bmailto:|\bwww\.)\S+/gi, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\s+/g, " ").trim();
  const who = label ? `${label}: ` : "";
  if (!prose) return `${who}response ready. On screen.`;
  // First sentence: a real character before the stop, so "3.14" is not a boundary.
  const first = /^.*?[^\d\s][.!?](?=\s|$)/.exec(prose)?.[0] ?? prose;
  const points = Array.from(first);
  const cue = points.length <= CUE_LIMIT
    ? first
    : points.slice(0, CUE_LIMIT).join("").replace(/\s+\S*$/, "") + "…";
  return `${who}${cue} On screen.`;
}

export interface SpokenCompletion {
  /** `${sessionId}:${seq}` of the last live event, so a duplicate idle is silent. */
  id: string;
  sessionId: string;
  text: string;
  /** Agent and project, so a cue from another conversation says which. */
  label?: string;
}

export interface ReadAloudDriver {
  stop(): Promise<void>;
  speak(text: string, done: () => void, error: () => void, current: () => boolean): Promise<void>;
}

/** Owns cancellation outside React so native/permission races can be tested. */
export class SpokenPlayback {
  enabled = false;
  speaking = false;
  capturing = false;
  private foreground = true;
  private latest: SpokenCompletion | undefined;
  private generation = 0;
  private stopping: Promise<boolean> = Promise.resolve(true);
  private disposed = false;

  constructor(
    private readonly driver: ReadAloudDriver,
    private readonly changed: () => void,
    private readonly report: (message: string) => void,
  ) {}

  get canReplay(): boolean {
    return this.enabled && this.foreground && !this.capturing && !!this.latest;
  }

  /** Any open conversation may cue; only leaving the screen silences and forgets. */
  context(foreground: boolean): void {
    if (this.foreground !== foreground) {
      this.latest = undefined;
      void this.stop();
    }
    this.foreground = foreground;
  }

  toggle(): void {
    this.enabled = !this.enabled;
    if (!this.enabled) void this.stop();
    this.changed();
  }

  complete(turn: SpokenCompletion): void {
    if (this.disposed || !this.foreground) return;
    if (this.latest?.id === turn.id) return;
    this.latest = turn;
    this.changed();
    if (this.enabled && !this.capturing) void this.play(turn);
  }

  replay(): void {
    if (this.canReplay && this.latest) void this.play(this.latest);
  }

  async microphone(): Promise<boolean> {
    this.capturing = true; // Block completions even while native stop is pending.
    this.changed();
    return await this.stop();
  }

  captureEnded(): void {
    this.capturing = false;
    this.changed();
  }

  async stop(): Promise<boolean> {
    ++this.generation;
    this.speaking = false;
    if (!this.disposed) this.changed();
    const previous = this.stopping;
    const stop = async (): Promise<boolean> => {
      await previous;
      try {
        await this.driver.stop();
        return true;
      } catch {
        if (!this.disposed) this.report("Could not stop speech. Try again before using the microphone.");
        return false;
      }
    };
    this.stopping = stop();
    return await this.stopping;
  }

  activate(): void {
    this.disposed = false;
  }

  dispose(): void {
    this.disposed = true;
    this.latest = undefined;
    void this.stop();
  }

  private async play(turn: SpokenCompletion): Promise<void> {
    const stopped = this.stop();
    const ticket = this.generation;
    if (!await stopped || ticket !== this.generation || !this.canReplay || this.disposed) return;
    this.speaking = true;
    this.changed();
    const finish = (failed: boolean): void => {
      if (ticket !== this.generation || this.disposed) return;
      this.speaking = false;
      this.changed();
      if (failed) this.report("Speech is unavailable or was interrupted. Read the response on screen.");
    };
    try {
      await this.driver.speak(
        spokenCue(turn.text, turn.label), () => finish(false), () => finish(true),
        () => ticket === this.generation && this.canReplay && !this.disposed,
      );
    } catch {
      finish(true);
    }
  }
}
