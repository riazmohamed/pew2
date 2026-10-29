/**
 * pew2 daemon.
 *
 * Runs on the user's machine. Owns provider discovery, agent processes, and the
 * per-session event log, then bridges all of it to the relay over one WebSocket.
 *
 * It is deliberately the fan-out point: ACP is a 1-client-to-1-agent protocol,
 * so the daemon — not the agent — is what lets a phone and a desktop observe the
 * same session at the same time.
 */
import { homedir } from "node:os";
import path from "node:path";
import {
  loadProviders,
  isAvailable,
  commandPath,
  unavailableReason,
} from "./providers/registry.js";
import { catalogEnabled, catalogEntries, idsToToggle } from "./providers/catalog.js";
import type { AskAnswer, ConfigOption } from "./acp/connect.js";
import { encodeCwd, loadGgCoderDisplayHistory } from "./acp/ggcoder-history.js";
import { SessionLog } from "./session/log.js";
import { type DeskResult, Desk } from "./desk.js";
import {
  GgCoderMirror,
  conversationNames,
  findConversationFile,
  findNewConversation,
} from "./acp/ggcoder-mirror.js";
import {
  KEYS,
  NATIVE_ALIVE_POLL_MS,
  NATIVE_APPS,
  nativeCloseScript,
  nativeWriteScript,
  NativeTyper,
  defaultNativeDeps,
  nativeAlive,
  nativeProviders,
  nativeReadScript,
  parseOgCoderScreen,
  applyDeskScreen,
  NATIVE_READ_POLL_MS,
  NATIVE_READ_QUIET_MS,
  type DeskScreen,
  openNativeWindow,
  typeable,
  type NativeDeskDeps,
} from "./native-desk.js";
import {
  APP_NAME,
  APP_PROVIDERS,
  AppDesk,
  AppTyper,
  appPhoneFile,
  type AppDeskOptions,
  type AppEvent,
} from "./app-desk.js";
import { readDisabled, setEnabled } from "./providers/enabled.js";
import { discardAttachments, storeAttachments } from "./attachments.js";
import { folderName } from "./workspace.js";
import { readProbeCache } from "./probe-cache.js";
import { readConfigPrefs, writeConfigPref } from "./config-prefs.js";
import { writeSessionPrefs } from "./session-prefs.js";
import type { wire } from "@pew2/protocol";
import {
  KeepAwake,
  awakePlatform,
  readKeepAwakeEnabled,
  writeKeepAwakeEnabled,
  type KeepAwakeStatus,
} from "./keep-awake.js";
import { DaemonConnectSession } from "./daemon/connect-session.js";
import { pushVoiceRing, ringCaller, ringTitle } from "./push.js";
import { VoiceController } from "./voice/controller.js";
import { voicePaths } from "./voice/credentials.js";
import { ThreadStore, threadKey } from "./voice/threads.js";
import { userProvidersDir } from "./providers/registry.js";
import { dirname, join } from "node:path";
import type { SessionStatus } from "./voice/session.js";
import type { VoiceChat } from "./voice/chats.js";
import { permissionOptionsFrom, type PermissionOption } from "./voice/tools.js";
import { lastAgentLines, currentActivity } from "./voice/replies.js";
import { hitLimit } from "./voice/models.js";
import {
  GG_GOALS_ID,
  GG_PROVIDER_ID,
  REPLAY_BATCH_SIZE,
  goalsProviderFrom,
  queuedForWire,
  rememberTurnText,
  withStoredPrefs,
  type ActiveSession,
  type NativeSession,
} from "./daemon/types.js";

export {
  GG_GOALS_ID,
  GG_PROVIDER_ID,
  goalsRoot,
  withStoredPrefs,
  type PromptOutcome,
  type ProviderCapabilities,
} from "./daemon/types.js";

/** Test seams for the native window path. */
export interface NativeOptions extends Partial<NativeDeskDeps> {
  platform?: NodeJS.Platform;
  sessionsRoot?: string;
  pollMs?: number;
  alivePollMs?: number;
  closeWaitMs?: number;
  closePollMs?: number;
  readPollMs?: number;
  turnGraceMs?: number;
  newConversationTimeoutMs?: number;
  readQuietMs?: number;
  settleMs?: number;
  throttleMs?: number;
  /** The GG Coder app's discovery (file, fetch, pid check) for tests. */
  appDesk?: Omit<AppDeskOptions, "onChange" | "onEvent">;
}

/** A live session's state, read-only, for tests and diagnostics. */
export interface NativeSessionView {
  sessionId: string;
  providerId: string;
  cwd: string;
  agentSessionId?: string;
  working: boolean;
  permissions: { requestId: string; params: unknown }[];
}

export class Daemon extends DaemonConnectSession {
  private readonly nativeOptions: NativeOptions;
  private readonly nativeDeps: NativeDeskDeps;
  /** The GG Coder desktop app, when its phone control is on. Inert until `startAppDesk`. */
  readonly appDesk: AppDesk;

  constructor(
    machine: { id: string; name: string },
    includeExperimental = false,
    env: NodeJS.ProcessEnv = process.env,
    native: NativeOptions = {},
  ) {
    super(machine, includeExperimental, env);
    this.nativeOptions = native;
    this.nativeDeps = { ...defaultNativeDeps(), ...native };
    this.appDesk = new AppDesk({
      file: appPhoneFile(env),
      ...native.appDesk,
      onChange: (available) => this.appAvailabilityChanged(available),
      onEvent: (event) => this.appEvent(event),
    });
    this.awake = this.createKeepAwake();
  }

  /**
   * Latest half-typed draft per conversation ("" = not started yet).
   *
   * Memory only, and never a session event: logged with a `seq`, a draft would
   * replay keystroke by keystroke on every reconnect.
   */
  private readonly drafts = new Map<string, { text: string; from?: string; at: number }>();

  /** Record (or, with empty text, clear) a draft. Returns the frame to broadcast. */
  setDraft(sessionId: string | undefined, text: string, from?: string): wire.DraftUpdate {
    const key = sessionId ?? "";
    const at = Date.now();
    if (text === "") this.drafts.delete(key);
    else this.drafts.set(key, { text, from, at });
    return { t: "session.draft", ...(sessionId !== undefined && { sessionId }), text, from, at };
  }

  /** Every held draft, as frames for a client that just joined. */
  draftFrames(): wire.DraftUpdate[] {
    return [...this.drafts].map(([key, draft]) => ({
      t: "session.draft",
      ...(key !== "" && { sessionId: key }),
      text: draft.text,
      from: draft.from,
      at: draft.at,
    }));
  }

  /** Keeps the machine from idle-sleeping while in use. Inert until `startKeepAwake`. */
  private readonly awake: KeepAwake;
  /** Opens `pew2 chat` windows on this screen when the phone asks. */
  readonly desk = new Desk();
  private lastClientAt?: number;

  private createKeepAwake(): KeepAwake {
    return new KeepAwake({
      platform: awakePlatform(process.platform, process.pid),
      state: () => {
        let working = false;
        let permissionPending = false;
        for (const session of this.sessions.values()) {
          if (session.working) working = true;
          // An open ask_user question is the same kind of wait as an approval.
          if ((session.permissions?.size ?? 0) > 0 || (session.asks?.size ?? 0) > 0)
            permissionPending = true;
        }
        return { working, permissionPending, lastClientAt: this.lastClientAt };
      },
      readEnabled: () => readKeepAwakeEnabled(this.env),
      writeEnabled: (enabled) => writeKeepAwakeEnabled(enabled, this.env),
      onChange: () => this.announceProviders(),
    });
  }

  /**
   * Begin holding sleep assertions per the policy. Only the server calls this,
   * so a Daemon built in a test never spawns `caffeinate`.
   */
  startKeepAwake(): Promise<void> {
    return this.awake.start();
  }

  /**
   * Follow the GG Coder app's discovery file. Only the server calls this, so a
   * Daemon built in a test reads nothing from the real home folder.
   */
  startAppDesk(): Promise<void> {
    return this.appDesk.start();
  }

  get keepAwakeStatus(): KeepAwakeStatus {
    return this.awake.status;
  }

  /** The user's switch, from any client. Persisted, then always re-announced. */
  async setKeepAwake(enabled: boolean): Promise<void> {
    await this.awake.setEnabled(enabled);
    this.announceProviders();
  }

  /** A client said something: someone is using this machine. */
  noteClientActivity(now: number = Date.now()) {
    this.lastClientAt = now;
    this.awake.evaluate();
  }

  /** A live session's state, read-only. Undefined once it is gone. */
  sessionView(sessionId: string): NativeSessionView | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return {
      sessionId,
      providerId: session.providerId,
      cwd: session.cwd,
      agentSessionId: session.agentSessionId,
      working: session.working === true,
      permissions: [...(session.permissions ?? [])].map(([requestId, params]) => ({
        requestId,
        params,
      })),
    };
  }

  /** Re-check the keep-awake policy; called by the layers below on turn and approval changes. */
  protected evaluateAwake() {
    this.awake.evaluate();
  }

  /** Point the daemon at a transport. Called with the relay socket's `send`. */
  attach(send: (message: unknown) => void) {
    this.send = send;
    // Created here so the call policy runs from boot, not from the first voice frame.
    void this.voice;
    // Started here rather than in the constructor so building a Daemon in a test
    // does not leave a timer running. `unref` for the same reason: this must
    // never be the thing keeping the process alive.
    if (!this.reaper) {
      this.reaper = setInterval(() => this.reapIdleSessions(), Daemon.REAP_INTERVAL_MS);
      this.reaper.unref?.();
    }
  }

  /** Record a pending update and tell every client at once. */
  setUpdateStatus(status: { latest: string; automatic: boolean } | undefined) {
    this.updateStatus = status;
    this.announceProviders();
  }

  /**
   * Why this daemon is not safe to end right now, or undefined if it is.
   *
   * "Quiet" is the precondition for exiting to pick up a new binary. It is not
   * about elapsed time: a session can be silent for minutes while an agent
   * thinks or runs a long tool, and ending the process then loses that turn's
   * work with no way to resume it mid-flight.
   *
   * Three things make a daemon busy, and each is a different kind of loss:
   * a turn in flight (`working`) would be abandoned mid-write; an open
   * permission is a question already on someone's screen, and killing it makes
   * the tap do nothing; a session still opening has an agent process spawned
   * and not yet usable, which would be leaked rather than closed cleanly.
   *
   * Returns a reason rather than a boolean so a caller can log *why* it is
   * waiting — a daemon that never seems to update is otherwise unexplainable.
   */
  busyReason(): string | undefined {
    for (const [sessionId, session] of this.sessions) {
      if (session.working) return `session ${sessionId} is mid-turn`;
      if (
        (session.permissions?.size ?? 0) > 0 ||
        (session.working && (session.asks?.size ?? 0) > 0)
      ) {
        return `session ${sessionId} is waiting on an approval`;
      }
      if (!session.agentSessionId) return `session ${sessionId} is still opening`;
    }
    return undefined;
  }

  /**
   * End one conversation and release everything it holds.
   *
   * The single close path, because there are four callers — the idle reaper, the
   * live-session cap, an agent being disabled, and shutdown — and each used to
   * do its own subset. Only shutdown discarded the attachment files, so every
   * photo sent to a conversation that was later reaped stayed in the tempdir for
   * the daemon's lifetime.
   *
   * Deliberately silent: the callers batch one `announceProviders` per pass,
   * because the message is a full snapshot of `activeSessions`.
   */
  private closeSession(sessionId: string, session: ActiveSession) {
    // Every device closes the card on this, before the session goes.
    for (const requestId of [...(session.asks?.keys() ?? [])]) this.closeAsk(session, requestId);
    if (session.replayTimer) clearTimeout(session.replayTimer);
    session.replayTimer = undefined;
    // A native window is the user's own: closing only stops mirroring it.
    if (session.native) stopNative(session.native);
    session.handle?.close();
    // The files were only ever a delivery mechanism for the agent that is now
    // gone. Best effort, and in the tempdir either way.
    void discardAttachments(session.log.sessionId);
    this.sessions.delete(sessionId);
    this.drafts.delete(sessionId);
    this.voiceController?.sessionClosed(sessionId);
    this.touchInbox();
  }

  /** The voice layer: inbox, call policy, sign-in and minting. Created on first use. */
  get voice(): VoiceController {
    this.voiceController ??= new VoiceController(
      {
        inboxSources: () =>
          [...this.sessions.values()].map((session) => ({
            sessionId: session.log.sessionId,
            ...this.sessionNotice(session.log.sessionId),
            permissions: session.permissions,
            asks: session.asks,
            plan: session.plan,
          })),
        boardSources: () =>
          [...this.sessions.values()]
            .filter((session) => session.live)
            .map((session) => {
              const { folder, agentName } = this.sessionNotice(session.log.sessionId);
              return {
                sessionId: session.log.sessionId,
                providerId: session.providerId,
                ...(folder ? { folder } : {}),
                ...(agentName ? { agentName } : {}),
                working: session.working === true,
                permissions: session.permissions,
                asks: session.asks,
                plan: session.plan,
                events: session.log.events,
              };
            }),
        broadcast: (message) => this.send(message),
        ring: (push) => {
          const ringId = `ring_${Date.now().toString(36)}`;
          // Over the socket too, for a phone the system cannot ring (Android):
          // it rings itself. A CallKit phone ignores this (see `wire.VoiceRing`).
          this.send({
            t: "voice.ring",
            ringId,
            title: ringTitle(push),
            caller: ringCaller(push),
            body: push.body,
            ...(push.focus ? { focus: push.focus } : {}),
          } satisfies wire.VoiceRing);
          void pushVoiceRing(
            this.pushTargets,
            { ...push, badge: this.waitingOnYou() },
            { relay: this.ringRelay, ringId, log: (line) => console.log(line) },
          );
        },
        threadFor: (sessionId) => {
          const session = this.sessions.get(sessionId);
          if (!session?.agentSessionId) return undefined;
          return {
            key: threadKey(session.providerId, session.agentSessionId),
            label: folderName(session.cwd),
          };
        },
      },
      {
        paths: voicePaths(this.env),
        log: (line) => console.log(line),
        threads: new ThreadStore(join(dirname(userProvidersDir(this.env)), "voice-threads.json")),
      },
    );
    return this.voiceController;
  }

  /** What each live session is doing, for the voice briefing and `get_status`. */
  /**
   * Every conversation Pew may reach by voice, newest first: each usable
   * agent's stored history (the uncapped list, read from the probe cache, so
   * listing never starts an agent), with the live session id when it is open
   * right now. GG Goals is left out: its sessions belong to goal folders.
   */
  async voiceChats(): Promise<VoiceChat[]> {
    const live = new Map<string, string>();
    for (const session of this.sessions.values()) {
      if (session.agentSessionId)
        live.set(`${session.providerId}\u0000${session.agentSessionId}`, session.log.sessionId);
    }
    const chats: VoiceChat[] = [];
    for (const provider of this.providers) {
      const providerId = provider.manifest.id;
      if (providerId === GG_GOALS_ID || !this.isEnabled(providerId) || !isAvailable(provider))
        continue;
      if (provider.manifest.pew.experimental && !this.includeExperimental) continue;
      for (const stored of await this.projectsWithHistory(providerId)) {
        const liveId = live.get(`${providerId}\u0000${stored.sessionId}`);
        chats.push({
          providerId,
          agentName: provider.manifest.name,
          agentSessionId: stored.sessionId,
          cwd: stored.cwd,
          ...(stored.title ? { title: stored.title } : {}),
          ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
          ...(liveId ? { liveSessionId: liveId } : {}),
        });
      }
    }
    return chats.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  /** An agent's display name ("Claude Code"), or undefined for one this daemon doesn't have. */
  providerName(providerId: string): string | undefined {
    return this.providers.find((p) => p.manifest.id === providerId)?.manifest.name;
  }

  /** The agents Pew may start a chat with: id and display name. */
  voiceAgents(): { providerId: string; agentName: string }[] {
    return this.providers
      .filter(
        (p) => p.manifest.id !== GG_GOALS_ID && this.isEnabled(p.manifest.id) && isAvailable(p),
      )
      .filter((p) => !p.manifest.pew.experimental || this.includeExperimental)
      .map((p) => ({ providerId: p.manifest.id, agentName: p.manifest.name }));
  }

  /**
   * A project path Pew named from this daemon's own history: filed as chosen,
   * so the app's later requests naming it (it re-sends the cwd for days) are
   * recognised for any agent, not only the one whose history it came from.
   */
  /**
   * Every project folder pew2 knows (chosen before, or with any chat), for a
   * project named on a call that is outside Pew's recent reach.
   */
  async voiceProjects(): Promise<string[]> {
    const chats = await this.voiceChats().catch(() => []);
    return [...new Set([...(await this.chosenProjects()), ...chats.map((chat) => chat.cwd)])];
  }

  async acceptVoiceProject(cwd: string): Promise<string> {
    return this.rememberProject(cwd);
  }

  voiceStatuses(sessionId?: string): SessionStatus[] {
    return [...this.sessions.values()]
      .filter((session) => session.live && (!sessionId || session.log.sessionId === sessionId))
      .map((session) => {
        const { folder, agentName } = this.sessionNotice(session.log.sessionId);
        return {
          sessionId: session.log.sessionId,
          ...(folder ? { folder } : {}),
          ...(agentName ? { agentName } : {}),
          working: session.working === true,
          // One session asked for by name: enough of its reply to answer
          // "what did it find?". The whole list: a line or three each.
          lastLines: lastAgentLines(session.log.events, sessionId ? 8 : 3),
          ...(session.working ? { activity: currentActivity(session.log.events) } : {}),
          ...this.limitOf(session.log.sessionId, session.working === true, session.log.events),
        };
      });
  }

  /** How each session's last turn failed, while it stays the last (`noteTurnEnd`). */
  private readonly turnFailures = new Map<string, string>();

  /** A turn ended: remember a failure's reason, forget it on a clean end. */
  noteTurnEnd(sessionId: string, failure?: string): void {
    if (failure) this.turnFailures.set(sessionId, failure.slice(0, 300));
    else this.turnFailures.delete(sessionId);
  }

  /** `{ limit }` when an idle session's last turn stopped on a usage or rate limit. */
  private limitOf(
    sessionId: string,
    working: boolean,
    events: readonly wire.SessionEvent[],
  ): { limit?: string } {
    if (working) return {};
    const failure = this.turnFailures.get(sessionId);
    const limit = hitLimit([...lastAgentLines(events, 4), ...(failure ? [failure] : [])]);
    return limit ? { limit } : {};
  }

  /** The options of a still-open permission, or undefined once it is answered. */
  voicePermissionOptions(sessionId: string, requestId: string): PermissionOption[] | undefined {
    const params = this.sessions.get(sessionId)?.permissions?.get(requestId);
    return params === undefined ? undefined : permissionOptionsFrom(params);
  }

  /** An open `ask_user`'s questions, for the voice model to read the choices out. */
  voiceAskQuestions(sessionId: string, requestId: string): unknown[] | undefined {
    return this.sessions.get(sessionId)?.asks?.get(requestId);
  }

  /** A session's model menu and current model, for `set_model`. Undefined: none, or no such session. */
  voiceModels(
    sessionId: string,
  ): { current?: string; options: { value: string; name?: string }[] } | undefined {
    if (!this.sessions.has(sessionId)) return undefined;
    const model = this.configOptions(sessionId).find(
      (option) => option.id === "model" || option.category === "model",
    );
    if (!model?.options?.length) return undefined;
    return {
      ...(typeof model.currentValue === "string" ? { current: model.currentValue } : {}),
      options: model.options.map((option) => ({ value: option.value, name: option.name })),
    };
  }

  /** Whether a turn is running, so a voice message knows it will queue. */
  isWorking(sessionId: string): boolean | undefined {
    const session = this.sessions.get(sessionId);
    return session ? session.working === true : undefined;
  }

  /**
   * Close agents for conversations nobody has touched in a long time.
   *
   * The process is the expensive part, not the conversation: the transcript is
   * on disk and the agent keeps its own history, so a closed session reopens by
   * resuming. What is being reclaimed is a language server sitting at 90-370MB
   * for a chat that was finished hours ago.
   *
   * Clients are told through the ordinary `providers` announce, whose
   * `activeSessions` is exactly the list of sessions this process still holds.
   * The app already reacts to an id disappearing from it — that is how it
   * survives a daemon restart — and resumes the conversation on screen instead
   * of prompting an id that no longer exists. Reaping deliberately reuses that
   * path rather than inventing a second one, so an older app on TestFlight
   * handles this correctly too.
   *
   * @param now Injectable for tests; the reaper is on an hour-long clock.
   * @returns The session ids closed.
   */
  reapIdleSessions(now: number = Date.now()): string[] {
    const reaped: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      // A turn in flight is never idle, however quiet it has gone: an agent can
      // spend minutes inside one tool call without emitting anything. Unless it
      // is not working at all but waiting on an approval nobody answered, which
      // is the one kind of stopped that lasts for ever.
      // An open ask_user question is the same kind of wait.
      // Only while working: an idle session with an open ask is just idle.
      const blocked =
        (session.permissions?.size ?? 0) > 0 ||
        (session.working === true && (session.asks?.size ?? 0) > 0);
      if (session.working && !blocked) continue;
      // Holds no agent, and ends with its window (see `watchNativeWindow`).
      if (session.native) continue;
      const ttl = blocked ? Daemon.BLOCKED_TTL_MS : Daemon.SESSION_TTL_MS;
      if (now - session.lastUsedAt < ttl) continue;
      // Nothing to resume from means nothing to come back to. A conversation
      // the agent never named would be lost rather than closed, so it is kept
      // — these are rare and short-lived, since the id arrives during the
      // handshake.
      if (!session.agentSessionId) continue;
      this.closeSession(sessionId, session);
      reaped.push(sessionId);
    }
    // Announce once for the whole pass, not once per session: the message is a
    // full snapshot, so repeating it per id would be the same list several times.
    if (reaped.length > 0) this.announceProviders();
    return reaped;
  }

  /**
   * Close the least recently used conversations until only `MAX_LIVE_SESSIONS`
   * hold an agent. Called as a new one opens, so the ceiling is enforced at the
   * moment memory would actually grow rather than up to five minutes later.
   *
   * Least recently *used*, not oldest: a conversation started this morning and
   * still being worked in outranks one opened ten minutes ago and abandoned.
   *
   * @param exempt The session being opened, which must never be the one closed.
   * @returns The session ids closed.
   */
  private enforceSessionCap(exempt: string): string[] {
    const closable = [...this.sessions.entries()]
      // Same three exclusions the reaper uses, for the same reasons: a turn in
      // flight would lose work, and a conversation the agent never named has
      // nothing to resume from, so closing it loses it rather than parks it.
      .filter(
        ([id, s]) => id !== exempt && !s.working && s.agentSessionId !== undefined && !s.native,
      )
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    // A native mirror holds no agent process, so it does not count.
    const held = [...this.sessions.values()].filter((s) => !s.native).length;
    const excess = held - Daemon.MAX_LIVE_SESSIONS;
    const closed: string[] = [];
    for (const [sessionId, session] of closable.slice(0, Math.max(0, excess))) {
      this.closeSession(sessionId, session);
      closed.push(sessionId);
    }
    // Same announce the reaper sends, and for the same reason: `activeSessions`
    // is how a client learns an id it still lists no longer exists here. Without
    // it the phone would keep offering a conversation whose agent is gone and
    // prompt it, which fails with "Unknown session" instead of resuming.
    if (closed.length > 0) this.announceProviders();
    return closed;
  }

  /** Rescan `providers/`. Safe to call at any time — this is what makes a newly
   *  added manifest show up on the phone without a restart. */
  async refreshProviders(): Promise<{ errors: { source: string; message: string }[] }> {
    const { providers, errors } = await loadProviders();
    const gg = providers.findIndex((p) => p.manifest.id === GG_PROVIDER_ID);
    const ggProvider = providers[gg];
    if (ggProvider && !providers.some((p) => p.manifest.id === GG_GOALS_ID)) {
      providers.splice(gg + 1, 0, goalsProviderFrom(ggProvider));
    }
    this.providers = providers;
    // Re-read every refresh, so `pew2 providers disable` takes effect without
    // restarting the daemon.
    this.disabled = await readDisabled(this.env);
    this.closeDisabled();
    this.announceProviders();
    return { errors };
  }

  /**
   * Stop agents the user has just turned off.
   *
   * Turning one off only ever stopped it being announced, probed or spawned
   * *next* time. Anything already running kept running, so a machine that had
   * warmed Cline and Qwen before they were deselected still had both resident
   * hours later — which reads as the switch not working, and is the whole
   * reason someone turns an agent off.
   */
  private closeDisabled() {
    for (const [key, spare] of this.spares) {
      if (this.isEnabled(spare.providerId)) continue;
      clearTimeout(spare.timer);
      this.retire(spare.handle);
      this.spares.delete(key);
    }
    for (const [sessionId, session] of this.sessions) {
      if (this.isEnabled(session.providerId)) continue;
      // A turn in flight is left alone. Killing an agent mid-answer would lose
      // work the user is waiting on, and the session is reaped on its own clock
      // once it finishes.
      if (session.working) continue;
      this.closeSession(sessionId, session);
    }
  }

  /**
   * Turn an agent on or off from the phone, exactly as `pew2 providers
   * enable|disable` does, then re-announce: that announce is the answer.
   * Unknown ids are ignored rather than written.
   */
  async setProviderEnabled(providerId: string, enabled: boolean): Promise<void> {
    if (!this.providers.some((p) => p.manifest.id === providerId)) return;
    await setEnabled(idsToToggle(providerId, enabled), enabled, this.env);
    await this.refreshProviders();
  }

  /** Whether an agent may be announced, probed, or spawned. */
  protected isEnabled(providerId: string): boolean {
    // GG Goals follows ggcoder, here as in the phone's settings.
    return catalogEnabled(providerId, this.disabled);
  }

  private announceProviders() {
    const announce: wire.ProviderAnnounce = {
      t: "providers",
      machine: this.machine,
      providers: this.providers
        // Test fixtures are hidden unless explicitly asked for, so a demo or a
        // local run can still exercise the pipeline without any API keys.
        .filter((p) => !p.manifest.pew.experimental || this.includeExperimental)
        // Turned off by the user. Filtered here rather than in the app, so the
        // phone is never even told about an agent it should not offer.
        .filter((p) => this.isEnabled(p.manifest.id))
        // GG Goals rides ggcoder: never announced without it.
        .filter((p) => p.manifest.id !== GG_GOALS_ID || this.isEnabled(GG_PROVIDER_ID))
        // Not on this machine at all. Nothing about it can be acted on from a
        // phone \u2014 you cannot install a CLI from there \u2014 so a dimmed row for it
        // is a permanent piece of furniture that never becomes useful.
        //
        // This is also what makes the phone agree with `pew2 setup`: the picker
        // will not let these be chosen, so announcing them showed agents the
        // user was never offered. An agent that is installed but still needs a
        // key is a different case and stays, because it is really here and the
        // reason says what to do about it.
        .filter((p) => !p.commandMissing)
        .map((p) => ({
          id: p.manifest.id,
          name: p.manifest.name,
          description: p.manifest.description,
          transport: p.manifest.pew.transport,
          color: p.manifest.pew.color,
          requiresWorkspace: p.manifest.pew.requiresWorkspace,
          available: isAvailable(p),
          unavailableReason: unavailableReason(p),
        })),
      // This daemon relays `session.draft`; clients send none without it.
      drafts: true,
      keepAwake: this.awake.status,
      // Whether the phone may ask for a `pew2 chat` window on this screen.
      desk: this.deskAnnouncement(),
      // Which sessions this process actually holds. A client's list outlives
      // the daemon, so this is how it learns that an id it still shows died
      // with the previous process and must be resumed, not prompted.
      activeSessions: [...this.sessions.keys()],
      // Every known agent, on or off, for the phone's Agents settings.
      catalog: catalogEntries(this.providers, this.disabled, this.includeExperimental),
      // Omitted entirely when there is nothing to say, so an app that has been
      // told once does not keep a stale banner when the update lands.
      update: this.updateStatus,
    };
    this.send(announce);
  }

  /**
   * Append to the session's log, sending only once the session is live.
   *
   * The log gets every event either way — seqs stay gapless, so the flush in
   * `markLive` and the reconnect replay both see the complete history.
   */
  protected record(session: ActiveSession, payload: unknown) {
    rememberTurnText(session, payload);
    const event = session.log.append(payload);
    const kind = (payload as { kind?: unknown } | null)?.kind;
    if (kind === "permission_request" || kind === "ask_user" || kind === "ask_user_closed")
      this.touchInbox();
    else this.touchBoard();
    if (!session.live) return;
    if (!session.streamingReplay) {
      this.send(event);
      return;
    }
    (session.pendingReplay ??= []).push(event);
    // ACP can deliver a thousand notifications in one event-loop turn; a timer
    // cannot fire during that burst, so flush by size as well as by frame.
    if (session.pendingReplay.length >= REPLAY_BATCH_SIZE) {
      this.flushStreamingReplay(session, false);
      return;
    }
    if (!session.replayTimer) {
      session.replayTimer = setTimeout(() => this.flushStreamingReplay(session, false), 16);
      session.replayTimer.unref?.();
    }
  }

  private flushStreamingReplay(session: ActiveSession, complete: boolean) {
    if (session.replayTimer) clearTimeout(session.replayTimer);
    session.replayTimer = undefined;
    const events = session.pendingReplay?.splice(0) ?? [];
    if (events.length > 0 || complete) {
      this.send({ t: "session.replay", sessionId: session.log.sessionId, events, complete });
    }
  }

  /**
   * Tell clients about everything a session has already produced.
   *
   * Callers broadcast `session.started` first; this is what guarantees a client
   * never sees an event for a session it has not been introduced to.
   */
  markLive(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.live) return;
    session.live = true;
    // The backlog goes out as one batched frame rather than hundreds: the app
    // folds it into a single render. An empty frame still matters because it
    // marks a resumed transcript as fully loaded and dismisses its skeleton.
    const backlog = session.log.since(-1);
    this.send({ t: "session.replay", sessionId, events: backlog });
  }

  /** Announce first, then reveal resume history in frame-sized batches. */
  markStreaming(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.live) return;
    session.live = true;
    session.streamingReplay = true;
    session.pendingReplay = session.log.since(-1);
    this.flushStreamingReplay(session, false);
  }

  finishStreaming(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.flushStreamingReplay(session, true);
    session.streamingReplay = false;
  }

  async startSession(providerId: string, cwd: string): Promise<string> {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    // Checked here too, not just where the list is announced. A phone that
    // connected before the agent was turned off still holds the old list, and
    // tapping one of those rows would otherwise spawn the very process that
    // turning it off was meant to prevent.
    if (!this.isEnabled(providerId)) {
      throw new Error(`'${provider.manifest.name}' is turned off on this machine.`);
    }
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    // Assign our own session id up front so events are attributable even if the
    // agent's own `session/new` is slow or fails.
    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    // Registered before connecting so `record` has somewhere to hold events the
    // agent emits during the handshake itself.
    const session: ActiveSession = {
      handle: undefined,
      log,
      providerId,
      cwd,
      live: false,
      lastUsedAt: Date.now(),
      ready: Promise.resolve(),
    };
    this.sessions.set(log.sessionId, session);
    // Enforced as it opens, not on the reaper's five-minute tick: this is the
    // moment memory grows, and someone opening several conversations in a burst
    // would otherwise hold all of them until the next pass.
    this.enforceSessionCap(log.sessionId);

    try {
      await this.connectSession(session, provider, cwd, undefined);
    } catch (error) {
      // A session that never connected has no history worth keeping, and
      // leaving it registered would answer prompts with a broken handle.
      this.sessions.delete(log.sessionId);
      throw error;
    }

    return log.sessionId;
  }

  /**
   * The agent's own id for a session, once it has opened one.
   *
   * Clients list the agent's stored conversations alongside their own, so a
   * session started here has to name itself in the agent's terms — otherwise
   * the next history probe lists the very conversation on screen a second time
   * as a stub, and reopening *that* copy loses the session's settings.
   */
  agentSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentSessionId;
  }

  /** Selectors (model, thinking level, mode) advertised by a session's agent. */
  configOptions(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session?.native?.configOptions ?? session?.handle?.configOptions ?? [];
  }

  /** Begin restoring immediately; callers can announce before the agent is ready. */
  beginResumeSession(providerId: string, agentSessionId: string, cwd: string) {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    // Checked here too, not just where the list is announced. A phone that
    // connected before the agent was turned off still holds the old list, and
    // tapping one of those rows would otherwise spawn the very process that
    // turning it off was meant to prevent.
    if (!this.isEnabled(providerId)) {
      throw new Error(`'${provider.manifest.name}' is turned off on this machine.`);
    }
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    const session: ActiveSession = {
      handle: undefined,
      log,
      providerId,
      cwd,
      live: false,
      lastUsedAt: Date.now(),
      ready: Promise.resolve(),
    };
    this.sessions.set(log.sessionId, session);
    // Enforced as it opens, not on the reaper's five-minute tick: this is the
    // moment memory grows, and someone opening several conversations in a burst
    // would otherwise hold all of them until the next pass.
    this.enforceSessionCap(log.sessionId);
    session.ready = this.connectSession(session, provider, cwd, agentSessionId);
    return { sessionId: log.sessionId, ready: session.ready };
  }

  async resumeSession(providerId: string, agentSessionId: string, cwd: string) {
    const pending = this.beginResumeSession(providerId, agentSessionId, cwd);
    try {
      await pending.ready;
      return pending.sessionId;
    } catch (error) {
      this.sessions.delete(pending.sessionId);
      throw error;
    }
  }

  /**
   * Record a choice made before any session exists.
   *
   * The empty state offers the same selectors a live conversation does, but a
   * session is only created by the first prompt — so there is nothing to set
   * the option on yet. Storing it here is what makes the pill stick: the
   * session that prompt creates applies it on connect.
   */
  async rememberConfigOption(providerId: string, configId: string, value: string | boolean) {
    await writeConfigPref(providerId, configId, value);
    // Every other client is looking at the same empty state, and one of them
    // just changed what its next prompt will run on.
    void this.publishProviderConfig(providerId).catch(() => {});
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
    const session = this.require(sessionId);
    if (session.native) return this.setNativeConfigOption(session.native, configId, value);
    await session.ready;
    const updated = await session.handle!.setConfigOption(configId, value);
    // Only after the agent accepted it: remembering a rejected choice would
    // reapply a broken setting to every session that follows.
    void writeConfigPref(session.providerId, configId, value).catch(() => {});
    // ...and against this conversation, so reopening it restores the choice
    // rather than the agent's default. Both: the provider record seeds the next
    // new session, this one survives leaving and coming back.
    // Only when the agent named the conversation: without an id there is
    // nothing to key the record by, and a placeholder would hand its selectors
    // to the next session that also lacks one.
    const agentSessionId = session.agentSessionId;
    if (agentSessionId) {
      void writeSessionPrefs(session.providerId, agentSessionId, { [configId]: value }).catch(
        () => {},
      );
    }
    // The provider record above is what the *next* conversation opens with, so
    // the empty state has to move with it. Otherwise leaving this conversation
    // showed the selectors it was holding while the next prompt used these.
    void this.publishProviderConfig(session.providerId, updated).catch(() => {});
    return updated;
  }

  /** The `desk` field of the announcement, with `native` only when non-empty. */
  private deskAnnouncement(): wire.ProviderAnnounce["desk"] {
    const status = this.desk.status();
    const native = nativeProviders(
      this.providers
        .filter((p) => this.isEnabled(p.manifest.id))
        .map((p) => ({ id: p.manifest.id, commandMissing: p.commandMissing })),
      {
        platform: this.nativeOptions.platform ?? process.platform,
        hasITerm: this.nativeDeps.hasITerm(),
      },
    );
    // A picture of the screen goes wherever a window can be opened (macOS).
    const withCapture = status.available ? { ...status, capture: true } : status;
    const windows = this.deskWindows();
    const app = this.appProviders();
    return {
      ...withCapture,
      ...(native.length > 0 && { native }),
      ...(app.length > 0 && { app }),
      ...(windows.length > 0 && { windows }),
    };
  }

  /** Providers openable in the GG Coder app right now (macOS, app's phone control on). */
  private appProviders(): string[] {
    if ((this.nativeOptions.platform ?? process.platform) !== "darwin") return [];
    if (!this.appDesk.available) return [];
    return APP_PROVIDERS.filter(
      (id) =>
        this.isEnabled(id === GG_GOALS_ID ? GG_PROVIDER_ID : id) &&
        this.providers.some((p) => p.manifest.id === id),
    );
  }

  /**
   * The terminal windows the phone can close, by conversation. An app window
   * is `native` with `app: true`, so a phone that predates the app still
   * offers to close it.
   */
  private deskWindows(): { agentSessionId: string; kind: "native" | "chat"; app?: true }[] {
    const seen = new Set<string>();
    const windows: { agentSessionId: string; kind: "native" | "chat"; app?: true }[] = [];
    const add = (agentSessionId: string | undefined, kind: "native" | "chat", app = false) => {
      if (!agentSessionId || seen.has(`${kind}:${agentSessionId}`)) return;
      seen.add(`${kind}:${agentSessionId}`);
      windows.push({ agentSessionId, kind, ...(app && { app: true as const }) });
    };
    for (const session of this.sessions.values())
      if (session.native) add(session.agentSessionId, "native", session.native.kind === "app");
    for (const window of this.chatWindows.values()) add(window.agentSessionId, "chat");
    return windows;
  }

  /** `pew2 chat` windows opened from the phone, by iTerm session id, so the phone can close them. */
  private readonly chatWindows = new Map<string, { agentSessionId: string; providerId: string }>();
  private chatWindowTimer?: NodeJS.Timeout;

  /** Remember a `pew2 chat` window opened for a conversation. */
  trackChatWindow(sessionId: string, itermSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.agentSessionId) return;
    this.chatWindows.set(itermSessionId, {
      agentSessionId: session.agentSessionId,
      providerId: session.providerId,
    });
    this.watchChatWindows();
    this.announceProviders();
  }

  /** Forget chat windows the user closed by hand, so the phone stops offering to. */
  private watchChatWindows() {
    if (this.chatWindowTimer) return;
    let checking = false;
    this.chatWindowTimer = setInterval(() => {
      if (checking) return;
      if (this.chatWindows.size === 0) {
        clearInterval(this.chatWindowTimer);
        this.chatWindowTimer = undefined;
        return;
      }
      checking = true;
      void (async () => {
        let changed = false;
        for (const id of [...this.chatWindows.keys()]) {
          if (!(await nativeAlive(this.nativeDeps, id))) {
            this.chatWindows.delete(id);
            changed = true;
          }
        }
        if (changed) this.announceProviders();
      })()
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }, this.nativeOptions.alivePollMs ?? NATIVE_ALIVE_POLL_MS);
    this.chatWindowTimer.unref?.();
  }

  /**
   * Close the terminal window(s) pew2 opened for a conversation, from the
   * phone. The agent's own app is quit the way a person would (input emptied,
   * Ctrl-D) and `pew2 chat` with Ctrl-C; a window that ignores that is closed
   * outright. Refused while the agent is mid-reply: closing then would cut the
   * turn off. The conversation itself carries on: with its window gone the
   * phone reopens it through the agent as usual.
   */
  async closeDesk(target: { sessionId?: string; agentSessionId?: string }): Promise<DeskResult> {
    const agentSessionId =
      (target.sessionId ? this.sessions.get(target.sessionId)?.agentSessionId : undefined) ??
      target.agentSessionId;
    const natives = agentSessionId
      ? [...this.sessions.values()].filter(
          (session) => session.native && session.agentSessionId === agentSessionId,
        )
      : [];
    const chats = agentSessionId
      ? [...this.chatWindows.entries()]
          .filter(([, window]) => window.agentSessionId === agentSessionId)
          .map(([id]) => id)
      : [];
    if (natives.length === 0 && chats.length === 0) {
      return {
        ok: false,
        message: "There's no terminal open on the computer for this conversation.",
      };
    }
    for (const session of natives) {
      if (session.working) {
        const name = this.nativeName(session);
        return {
          ok: false,
          message: `${name} is in the middle of a reply. Stop it first, then close it.`,
        };
      }
    }

    const failed: string[] = [];
    for (const session of natives) {
      const native = session.native!;
      const closed =
        native.kind === "app"
          ? await native.typer.quit()
          : await this.closeTerminal(native.itermSessionId, () => native.typer.quit());
      if (!closed) {
        failed.push(
          native.kind === "app" ? APP_NAME : (NATIVE_APPS[session.providerId]?.name ?? "the agent"),
        );
        continue;
      }
      // Whatever it wrote last reaches the phone before the mirror goes.
      await native.mirror.kick().catch(() => {});
      const id = this.nativeSessionId(native);
      const current = id ? this.sessions.get(id) : undefined;
      if (id && current) this.closeSession(id, current);
    }
    for (const id of chats) {
      const closed = await this.closeTerminal(id, () =>
        this.nativeDeps.osa(nativeWriteScript(id, [KEYS.interrupt]), 8_000),
      );
      if (closed) this.chatWindows.delete(id);
      else failed.push("pew2 chat");
    }
    this.announceProviders();
    return failed.length === 0
      ? { ok: true }
      : { ok: false, message: `${failed.join(" and ")} didn't close. Close it on the Mac.` };
  }

  /** What the phone calls a session's window: the GG Coder app, or the agent's own name. */
  private nativeName(session: ActiveSession): string {
    if (session.native?.kind === "app") return APP_NAME;
    return NATIVE_APPS[session.providerId]?.name ?? "The agent";
  }

  /** Ask politely, wait for the window to go, then close it outright. */
  private async closeTerminal(
    itermSessionId: string,
    ask: () => Promise<unknown>,
  ): Promise<boolean> {
    await ask();
    if (await this.waitGone(itermSessionId)) return true;
    await this.nativeDeps.osa(nativeCloseScript(itermSessionId), 8_000);
    return this.waitGone(itermSessionId);
  }

  private async waitGone(itermSessionId: string): Promise<boolean> {
    const deadline = Date.now() + (this.nativeOptions.closeWaitMs ?? 5_000);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.nativeOptions.closePollMs ?? 400));
      if (!(await nativeAlive(this.nativeDeps, itermSessionId))) return true;
    }
    return false;
  }

  /** Whether this session is a native window being mirrored. */
  isNative(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.native !== undefined;
  }

  /** The mirror already showing this conversation, if any. */
  /**
   * Ids a conversation had before it moved into its own app's window (or was
   * re-keyed there), pointing at the id it moved to. A phone that missed the
   * announcement (a dropped connection) still sends the old one: followed
   * here rather than answered "Unknown session".
   */
  private readonly retired = new Map<string, string>();

  /** The live session an id now lives under: itself, or where it moved. Undefined if neither. */
  forwardedSession(sessionId: string): string | undefined {
    let id: string | undefined = sessionId;
    for (let hops = 0; id && hops < 8; hops += 1) {
      if (this.sessions.has(id)) return id === sessionId ? undefined : id;
      id = this.retired.get(id);
    }
    return undefined;
  }

  /**
   * The session already running this conversation in pew2's own agent, if
   * any. A resume of it is answered with that session instead of a second
   * agent: two agents on one conversation write one file, run every turn
   * twice, and doubled the requests in flight until the model provider
   * refused them (20-21 Oct: four OG Coder agents on one chat, after the app
   * restarted and reopened it each time).
   */
  liveSessionFor(providerId: string, agentSessionId: string): string | undefined {
    for (const [id, session] of this.sessions) {
      if (
        !session.native &&
        session.providerId === providerId &&
        session.agentSessionId === agentSessionId
      )
        return id;
    }
    return undefined;
  }

  /** Re-introduce a running session to clients, whole: as a resume of it would, without a new agent. */
  reannounce(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.native) return false;
    session.lastUsedAt = Date.now();
    this.send({
      t: "session.started",
      sessionId,
      providerId: session.providerId,
      configOptions: this.configOptions(sessionId),
      resumed: true,
      cwd: session.cwd,
      agentSessionId: session.agentSessionId,
    });
    this.send({ t: "session.replay", sessionId, events: session.log.since(-1), complete: true });
    this.send({
      t: "session.config",
      sessionId,
      providerId: session.providerId,
      configOptions: this.configOptions(sessionId),
    });
    // Where it stands now (a turn running, an approval open): the history
    // replay alone reads as idle.
    const latest = session.log.since(-1).at(-1)?.seq ?? 0;
    for (const frame of this.catchUp({ [sessionId]: latest })) this.send(frame);
    return true;
  }

  nativeSessionFor(providerId: string, agentSessionId: string): string | undefined {
    for (const [id, session] of this.sessions) {
      if (
        session.native &&
        session.providerId === providerId &&
        session.agentSessionId === agentSessionId
      )
        return id;
    }
    return undefined;
  }

  /** A phone draft, typed into the native window's input (no Enter). */
  nativeDraft(sessionId: string | undefined, text: string): void {
    if (!sessionId) return;
    this.sessions.get(sessionId)?.native?.typer.draft(text);
  }

  /** Re-introduce a mirror to a client that asked to resume it. */
  replayNative(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.native) return;
    this.send({ t: "session.replay", sessionId, events: session.log.since(-1), complete: true });
  }

  /**
   * Hand a conversation over to the agent's own terminal app.
   *
   * Only one process may write a conversation, so pew2's ACP session for it is
   * closed and the window resumes it by id. The window is then presented as a
   * session of its own (a fresh id, the same `agentSessionId`), so the phone
   * replaces the row and keeps sending exactly as before.
   */
  async openNative(sessionId: string, kind: "iterm" | "app" = "iterm"): Promise<DeskResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        message: "That conversation isn't open on the computer. Send it a message first.",
      };
    }
    if (session.native) {
      const app = session.native.kind === "app";
      return {
        ok: true,
        app: app ? APP_NAME : "iTerm",
        message: `It's already open in ${app ? "the GG Coder app" : "OG Coder"} on the computer.`,
      };
    }
    const provider = this.providers.find((p) => p.manifest.id === session.providerId);
    const allowed =
      (kind === "app" ? this.deskAnnouncement()?.app : this.deskAnnouncement()?.native) ?? [];
    if (!provider || !allowed.includes(session.providerId)) {
      return {
        ok: false,
        message:
          kind === "app"
            ? "The GG Coder app isn't available on the computer. Turn on Phone control in its settings."
            : "This agent can't be opened in its own app on this computer.",
      };
    }
    if ((session.permissions?.size ?? 0) > 0) {
      return {
        ok: false,
        message: "It's waiting for your approval. Answer that first, then open it on the computer.",
      };
    }
    if (session.working) {
      return {
        ok: false,
        message: "It's in the middle of a reply. Open it on the computer once it finishes.",
      };
    }
    const agentSessionId = session.agentSessionId;
    if (!agentSessionId) {
      return {
        ok: false,
        message: "That conversation hasn't finished opening yet. Try again in a moment.",
      };
    }
    const cwd = session.cwd;
    const providerId = session.providerId;
    // Taken before the ACP session closes, so the phone keeps its pills.
    const configOptions = this.configOptions(sessionId);

    const history = await loadGgCoderDisplayHistory(
      agentSessionId,
      cwd,
      this.nativeOptions.sessionsRoot,
    ).catch(() => undefined);
    return this.attachNative({
      kind,
      provider,
      providerId,
      cwd,
      configOptions,
      agentSessionId,
      history,
      resumed: true,
      // The window has the conversation now; pew2's own agent lets go of it.
      // Re-read: the session may have been closed while the window opened.
      beforeRegister: () => {
        const current = this.sessions.get(sessionId);
        if (current) this.closeSession(sessionId, current);
      },
    }).then((result) => {
      const moved = this.nativeSessionFor(providerId, agentSessionId);
      if (result.ok && moved) this.retired.set(sessionId, moved);
      return result;
    });
  }

  /**
   * A new conversation in the agent's own app, from the phone's empty screen:
   * the app is started plain in the project, and its conversation is mirrored
   * as soon as the app has written it. Announced as a *new* session (not a
   * resume), so the phone's empty view takes it as its own.
   */
  async openNativeNew(
    providerId: string,
    cwd: string,
    kind: "iterm" | "app" = "iterm",
  ): Promise<DeskResult> {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    const allowed =
      (kind === "app" ? this.deskAnnouncement()?.app : this.deskAnnouncement()?.native) ?? [];
    if (!provider || !allowed.includes(providerId)) {
      return {
        ok: false,
        message:
          kind === "app"
            ? "The GG Coder app isn't available on the computer. Turn on Phone control in its settings."
            : "This agent can't be opened in its own app on this computer.",
      };
    }
    const configOptions = withStoredPrefs(
      (await this.probes.get(providerId)?.catch(() => undefined))?.configOptions ??
        (await readProbeCache(providerId, this.env))?.configOptions ??
        [],
      await readConfigPrefs(providerId),
    );
    return this.attachNative({ kind, provider, providerId, cwd, configOptions, resumed: false });
  }

  /**
   * Open the window and present it to the phone as a session. With an
   * `agentSessionId` the window resumes that conversation; without one the app
   * starts fresh and the conversation it writes is found and mirrored.
   */
  private async attachNative(args: {
    kind?: "iterm" | "app";
    provider: { command: string };
    providerId: string;
    cwd: string;
    configOptions: ConfigOption[];
    agentSessionId?: string;
    history?: unknown[];
    resumed: boolean;
    beforeRegister?: () => void;
  }): Promise<DeskResult> {
    const { providerId, cwd, configOptions } = args;
    const directory = path.join(
      this.nativeOptions.sessionsRoot ?? path.join(homedir(), ".gg", "sessions"),
      encodeCwd(cwd),
    );
    const known = args.agentSessionId ? undefined : await conversationNames(directory);
    const openedAt = Date.now();

    // Baseline before the window exists, so everything OG Coder writes from
    // its resume onwards is new and nothing already on the phone repeats.
    const handles: { mirrorSession?: ActiveSession } = {};
    const makeMirror = (agentSessionId: string) =>
      new GgCoderMirror({
        agentSessionId,
        cwd,
        sessionsRoot: this.nativeOptions.sessionsRoot,
        pollMs: this.nativeOptions.pollMs,
        callbacks: {
          onUpdate: (update) =>
            handles.mirrorSession &&
            this.record(handles.mirrorSession, { sessionId: agentSessionId, update }),
          onUserMessage: (text) =>
            handles.mirrorSession &&
            this.record(handles.mirrorSession, { kind: "user_message", text }),
          onTurnStart: () => handles.mirrorSession && this.nativeTurnStart(handles.mirrorSession),
          onTurnEnd: () => handles.mirrorSession && this.nativeTurnEnd(handles.mirrorSession),
        },
      });
    let mirror = args.agentSessionId ? makeMirror(args.agentSessionId) : undefined;
    await mirror?.baseline();

    const isApp = args.kind === "app";
    const opened = isApp
      ? await this.openAppWindow(providerId, cwd, args.agentSessionId)
      : await openNativeWindow(this.nativeDeps, {
          // The full path: the window's login shell may not have the agent's
          // folder on its PATH (see `commandPath`).
          command: commandPath(args.provider.command, this.env) ?? args.provider.command,
          providerId,
          agentSessionId: args.agentSessionId,
          cwd,
        });
    if (!opened.ok) return { ok: false, message: opened.message };
    const appSessionId = "appSessionId" in opened ? opened.appSessionId : undefined;

    // A fresh app names its conversation once it has started: wait for the
    // file it writes, so the phone gets one session with its id attached.
    // The desktop app may name it straight away, or in its window list.
    let agentSessionId =
      args.agentSessionId ?? ("agentSessionId" in opened ? opened.agentSessionId : undefined);
    if (!agentSessionId) {
      const deadline = Date.now() + (this.nativeOptions.newConversationTimeoutMs ?? 20_000);
      while (!agentSessionId && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, this.nativeOptions.pollMs ?? 300));
        if (appSessionId) {
          const windows = await this.appDesk.client?.windows();
          agentSessionId =
            windows?.find((w) => w.sessionId === appSessionId)?.agentSessionId ?? undefined;
          if (agentSessionId) break;
        }
        agentSessionId = (await findNewConversation(directory, known ?? new Set(), openedAt))
          ?.agentSessionId;
      }
      if (!agentSessionId) {
        return {
          ok: true,
          app: isApp ? APP_NAME : "iTerm",
          message: `${isApp ? "The GG Coder app" : "OG Coder"} opened, but pew2 couldn't find its conversation, so the phone isn't linked to it.`,
        };
      }
      mirror = makeMirror(agentSessionId);
      await mirror.baseline();
    }

    args.beforeRegister?.();

    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    const native: NativeSession =
      appSessionId !== undefined
        ? {
            kind: "app",
            itermSessionId: "",
            appSessionId,
            typer: new AppTyper(
              () => this.appDesk.client,
              appSessionId,
              this.nativeOptions.throttleMs,
            ),
            mirror: mirror!,
            configOptions,
          }
        : {
            itermSessionId: "itermSessionId" in opened ? opened.itermSessionId : "",
            typer: new NativeTyper(
              "itermSessionId" in opened ? opened.itermSessionId : "",
              this.nativeDeps.osa,
              this.nativeOptions.throttleMs,
            ),
            mirror: mirror!,
            configOptions,
          };
    const mirrorSession: ActiveSession = {
      log,
      providerId,
      agentSessionId,
      cwd,
      live: false,
      lastUsedAt: Date.now(),
      ready: Promise.resolve(),
      native,
    };
    handles.mirrorSession = mirrorSession;
    for (const update of args.history ?? []) log.append({ sessionId: agentSessionId, update });
    this.sessions.set(log.sessionId, mirrorSession);

    // The same frames a resume sends, so the phone swaps the row over and
    // paints the transcript from this log. A new one is announced as new, so
    // the phone's empty screen claims it.
    this.send({
      t: "session.started",
      sessionId: log.sessionId,
      providerId,
      configOptions,
      ...(args.resumed && { resumed: true }),
      cwd,
      agentSessionId,
    });
    this.markStreaming(log.sessionId);
    this.finishStreaming(log.sessionId);
    this.send({ t: "session.config", sessionId: log.sessionId, providerId, configOptions });
    this.announceProviders();

    native.mirror.start();
    if (native.kind === "app") {
      this.watchAppWindow(native);
      return { ok: true, app: APP_NAME };
    }
    this.watchNativeWindow(native);
    this.readNativeWindow(native);
    return { ok: true, app: "iTerm" };
  }

  /** Open (or focus) the conversation in a GG Coder app window. */
  private async openAppWindow(
    providerId: string,
    cwd: string,
    agentSessionId: string | undefined,
  ): Promise<
    { ok: true; appSessionId: string; agentSessionId?: string } | { ok: false; message: string }
  > {
    const client = this.appDesk.client;
    if (!client) {
      return {
        ok: false,
        message:
          "The GG Coder app isn't available on the computer. Turn on Phone control in its settings.",
      };
    }
    const directory = path.join(
      this.nativeOptions.sessionsRoot ?? path.join(homedir(), ".gg", "sessions"),
      encodeCwd(cwd),
    );
    const sessionPath = agentSessionId
      ? (await findConversationFile(directory, { agentSessionId }).catch(() => undefined))?.file
      : undefined;
    const opened = await client.open({
      cwd,
      ...(agentSessionId && { agentSessionId }),
      ...(sessionPath && { sessionPath }),
      mode: providerId === GG_GOALS_ID ? "goal" : "code",
    });
    if (!opened.ok) {
      return {
        ok: false,
        message:
          opened.status === 401 || opened.status === 404
            ? "The GG Coder app refused the request. Check Phone control is on in its settings."
            : `Couldn't open the GG Coder app: ${opened.message}`,
      };
    }
    return {
      ok: true,
      appSessionId: opened.value.sessionId,
      ...(opened.value.agentSessionId && { agentSessionId: opened.value.agentSessionId }),
    };
  }

  /** The app session filed under its window id, if pew2 is mirroring it. */
  private appNative(appSessionId: string): NativeSession | undefined {
    for (const session of this.sessions.values())
      if (session.native?.kind === "app" && session.native.appSessionId === appSessionId)
        return session.native;
    return undefined;
  }

  /** An event from the app: hand-typed drafts reach the phone, closed windows end their mirror. */
  private appEvent(event: AppEvent) {
    if (event.type === "windows") return;
    const native = this.appNative(event.sessionId);
    if (!native) return;
    if (event.type === "closed") {
      void this.endNativeWindow(native);
      return;
    }
    const sessionId = this.nativeSessionId(native);
    if (!sessionId) return;
    // The app never echoes `/phone/draft` text, so this is the desk typing.
    native.deskInput = event.text;
    native.typer.observe(event.text);
    this.send(this.setDraft(sessionId, event.text, DESK_DRAFT_FROM));
  }

  /** The app came or went: re-announce, and a gone app ends every app mirror. */
  private appAvailabilityChanged(available: boolean) {
    if (!available) {
      for (const session of [...this.sessions.values()])
        if (session.native?.kind === "app") void this.endNativeWindow(session.native);
    }
    this.announceProviders();
  }

  /**
   * Polls the app's window list: a window gone (closed while the event stream
   * was down, or the app restarted) ends the mirror, and its `busy` is the
   * backstop for turns, as the status row is for iTerm.
   */
  private watchAppWindow(native: NativeSession) {
    let checking = false;
    native.aliveTimer = setInterval(() => {
      if (checking) return;
      checking = true;
      void (async () => {
        const windows = await this.appDesk.client?.windows();
        // Unknown (app slow) is not proof of a close; a gone app is handled by discovery.
        if (!windows) return;
        const window = windows.find((w) => w.sessionId === native.appSessionId);
        if (!window) return this.endNativeWindow(native);
        const sessionId = this.nativeSessionId(native);
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (session)
          this.applyNativeStatus(session, native, {
            status: window.busy ? "busy" : "idle",
            input: native.deskInput ?? "",
          });
      })()
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }, this.nativeOptions.alivePollMs ?? NATIVE_ALIVE_POLL_MS);
    native.aliveTimer.unref?.();
  }

  /** The window went: the agent's last words reach the phone, then the mirror lets go. */
  private async endNativeWindow(native: NativeSession) {
    if (!this.nativeSessionId(native)) return;
    await native.mirror.kick().catch(() => {});
    // Looked up again: a reopen may have re-keyed it meanwhile.
    const sessionId = this.nativeSessionId(native);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!sessionId || !session) return;
    if (session.working) this.nativeTurnEnd(session);
    this.closeSession(sessionId, session);
    this.announceProviders();
  }

  /**
   * A client reopening a conversation that is open in its own window. The
   * mirror is re-keyed to a fresh id and replayed whole: a reopen under the
   * *same* id was skipped by the phone's cursor (every event "already seen"),
   * which showed the conversation empty. Every client is told, like a resume.
   */
  reopenNative(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session?.native) return undefined;
    // Never the id it had, nor one in use: two re-keys in one millisecond
    // would otherwise file it under itself and forward it in a loop.
    let id = `${session.providerId}-${Date.now().toString(36)}`;
    while (id === sessionId || this.sessions.has(id))
      id = `${session.providerId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const log = new SessionLog(id);
    for (const event of session.log.since(-1)) log.append(event.payload);
    this.sessions.delete(sessionId);
    this.retired.set(sessionId, log.sessionId);
    const draft = this.drafts.get(sessionId);
    this.drafts.delete(sessionId);
    if (draft) this.drafts.set(log.sessionId, draft);
    session.log = log;
    session.live = false;
    this.sessions.set(log.sessionId, session);
    this.send({
      t: "session.started",
      sessionId: log.sessionId,
      providerId: session.providerId,
      configOptions: session.native.configOptions,
      resumed: true,
      cwd: session.cwd,
      agentSessionId: session.agentSessionId,
    });
    this.markStreaming(log.sessionId);
    this.finishStreaming(log.sessionId);
    this.send({
      t: "session.config",
      sessionId: log.sessionId,
      providerId: session.providerId,
      configOptions: session.native.configOptions,
    });
    this.announceProviders();
    return log.sessionId;
  }

  /** The session id a native window is currently filed under (it changes on reopen). */
  private nativeSessionId(native: NativeSession): string | undefined {
    for (const [id, session] of this.sessions) if (session.native === native) return id;
    return undefined;
  }

  /**
   * A phone pill changed on a conversation open in OG Coder: drive OG Coder to
   * it with its own controls. Model is its `/model <id>` command; thinking is
   * Shift+Tab, pressed until the status line shows the level. Plan mode has no
   * key from outside, so it is refused.
   */
  private async setNativeConfigOption(
    native: NativeSession,
    configId: string,
    value: string | boolean,
  ) {
    if (native.kind === "app") throw new Error(APP_CONFIG_REFUSAL);
    const option = native.configOptions.find((o) => o.id === configId);
    if (!option) throw new Error(`Unknown option '${configId}'`);
    if (option.category !== "model" && option.category !== "thought_level")
      throw new Error(NATIVE_CONFIG_REFUSAL);
    native.configuring = true;
    try {
      // Start from what OG Coder actually shows, not pew2's last record: the
      // desk may have changed it since.
      const before = await this.readNativeScreen(native);
      if (before) native.configOptions = applyDeskScreen(native.configOptions, before).options;
      const current = native.configOptions.find((o) => o.id === configId);
      if (current?.currentValue === value) return native.configOptions;

      if (option.category === "model") {
        if (!(await native.typer.command(`/model ${String(value)}`)))
          throw new Error(NATIVE_WINDOW_GONE);
      } else {
        // Shift+Tab one press at a time, reading the status line after each:
        // OG Coder's cycle is per model, so counting presses off the advertised
        // list goes wrong whenever the two differ.
        const values = (option.options ?? []).map((o) => o.value);
        let reached = false;
        for (let press = 0; press <= values.length && !reached; press++) {
          if (press > 0 && !(await native.typer.shiftTab(1))) throw new Error(NATIVE_WINDOW_GONE);
          const screen = press === 0 ? before : await this.settledScreen(native);
          if (!screen?.thinking) {
            // Unreadable screen: fall back to counting presses.
            if (!(await native.typer.shiftTab(cycleDistance(current ?? option, value))))
              throw new Error(NATIVE_WINDOW_GONE);
            reached = true;
            break;
          }
          reached = screen.thinking === String(value);
        }
        if (!reached)
          throw new Error(`OG Coder doesn't offer thinking '${String(value)}' for this model.`);
      }

      const after = await this.settledScreen(native);
      native.configOptions = after
        ? applyDeskScreen(native.configOptions, after).options
        : native.configOptions.map((o) => (o.id === configId ? { ...o, currentValue: value } : o));
      return native.configOptions;
    } finally {
      native.configuring = false;
    }
  }

  /**
   * Read the OG Coder window back, so what happens at the desk reaches the
   * phone: text typed (or cleared) in OG Coder's input becomes a draft from
   * `desk`, and the status line's model, thinking level and plan mode become
   * the phone's pills. Skipped while the phone's own typing is landing — the
   * screen is mid-keystroke then — and while a pill change is being driven.
   */
  private readNativeWindow(native: NativeSession) {
    let reading = false;
    native.readTimer = setInterval(() => {
      if (reading || native.configuring) return;
      reading = true;
      void this.readNativeScreen(native)
        .then((screen) => {
          const sessionId = this.nativeSessionId(native);
          const session = sessionId ? this.sessions.get(sessionId) : undefined;
          if (!screen || !sessionId || !session || native.configuring) return;
          this.applyNativeScreen(sessionId, session, native, screen);
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    }, this.nativeOptions.readPollMs ?? NATIVE_READ_POLL_MS);
    native.readTimer.unref?.();
  }

  private async readNativeScreen(native: NativeSession): Promise<DeskScreen | undefined> {
    const outcome = await this.nativeDeps.osa(nativeReadScript(native.itermSessionId), 5_000);
    if (outcome.code !== 0 || outcome.stdout.trim() === "gone") return undefined;
    return parseOgCoderScreen(outcome.stdout);
  }

  /** The screen once a keystroke has had time to redraw. */
  private async settledScreen(native: NativeSession): Promise<DeskScreen | undefined> {
    await new Promise((resolve) => setTimeout(resolve, this.nativeOptions.settleMs ?? 250));
    return this.readNativeScreen(native);
  }

  private applyNativeScreen(
    sessionId: string,
    session: ActiveSession,
    native: NativeSession,
    screen: DeskScreen,
  ) {
    this.applyNativeStatus(session, native, screen);
    const { options, changed } = applyDeskScreen(native.configOptions, screen);
    if (changed) {
      native.configOptions = options;
      this.send({
        t: "session.config",
        sessionId,
        providerId: session.providerId,
        configOptions: options,
      });
    }

    const input = screen.input;
    if (
      input === undefined ||
      native.typer.busy(this.nativeOptions.readQuietMs ?? NATIVE_READ_QUIET_MS)
    )
      return;
    const typed = native.typer.lastTyped;
    // What the phone typed, as the screen shows it (padding trims trailing
    // spaces off, so compare without them).
    if (typed !== undefined && typed.trimEnd() === input) {
      native.deskInput = input;
      return;
    }
    if (native.deskInput === input) return;
    // Typed or cleared at the desk: the phone shows it and its next edit
    // starts from it. An empty window on the first read says nothing about the
    // phone's box, so it clears nothing.
    const first = native.deskInput === undefined;
    native.deskInput = input;
    native.typer.observe(input);
    if (first && input === "") return;
    this.send(this.setDraft(sessionId, input, DESK_DRAFT_FROM));
  }

  /**
   * The screen as the last word on whether OG Coder is working. The file is
   * the main signal, but a turn stopped with Esc or failed outright may write
   * no final metric, and the phone would show it working forever. Two reads in
   * a row must agree, and a turn is given a few seconds to get going first, so
   * a stale "done" line just after Enter does not end the turn it started.
   */
  private applyNativeStatus(session: ActiveSession, native: NativeSession, screen: DeskScreen) {
    const status = screen.status;
    if (!status || screen.input === undefined) {
      native.statusRun = undefined;
      return;
    }
    native.statusRun =
      native.statusRun?.status === status
        ? { status, count: native.statusRun.count + 1 }
        : { status, count: 1 };
    if (native.statusRun.count < 2) return;
    if (status === "idle" && session.working) {
      const since = Date.now() - (session.turnStartedAt ?? 0);
      if (since < (this.nativeOptions.turnGraceMs ?? NATIVE_TURN_GRACE_MS)) return;
      // Whatever OG Coder wrote last reaches the phone before the turn ends.
      void native.mirror.kick().then(() => this.nativeTurnEnd(session));
    } else if (status === "busy" && !session.working) {
      // Started at the desk: the phone shows it working too.
      this.nativeTurnStart(session);
    }
  }

  /** End the mirror when its window closes or the agent in it exits. */
  private watchNativeWindow(native: NativeSession) {
    let checking = false;
    native.aliveTimer = setInterval(() => {
      if (checking) return;
      checking = true;
      void nativeAlive(this.nativeDeps, native.itermSessionId)
        .then((alive) => {
          if (alive || !this.nativeSessionId(native)) return;
          // Whatever the agent wrote last is on the phone before it lets go.
          return native.mirror.kick().then(() => {
            // Looked up again: a reopen may have re-keyed it meanwhile.
            const sessionId = this.nativeSessionId(native);
            const session = sessionId ? this.sessions.get(sessionId) : undefined;
            if (!sessionId || !session) return;
            if (session.working) this.nativeTurnEnd(session);
            this.closeSession(sessionId, session);
            this.announceProviders();
          });
        })
        .finally(() => {
          checking = false;
        });
    }, this.nativeOptions.alivePollMs ?? NATIVE_ALIVE_POLL_MS);
    native.aliveTimer.unref?.();
  }

  private nativeTurnStart(session: ActiveSession) {
    session.lastUsedAt = Date.now();
    if (session.working) return;
    session.working = true;
    session.turnStartedAt = Date.now();
    session.turnText = undefined;
    this.awake.evaluate();
    this.touchBoard();
  }

  private nativeTurnEnd(session: ActiveSession) {
    session.lastUsedAt = Date.now();
    if (!session.working) return;
    session.working = false;
    const sessionId = session.log.sessionId;
    this.awake.evaluate();
    // A call's lanes and a "call me when it's done" follow the window's turns
    // too: without this a native turn's end never reached the callback (26 Oct).
    this.touchBoard();
    // The same pair `session.prompt` sends at a turn's end: the spinner, and
    // the push for a phone that is asleep.
    this.send({ t: "session.idle", sessionId, ...this.sessionOrigin(sessionId) });
    this.notifyPhones(sessionId, "finished");
  }

  /** A phone prompt for a native window: typed in, then Enter. */
  protected async promptNative(
    session: ActiveSession,
    text: string,
    attachments: wire.PromptAttachment[],
  ) {
    const native = session.native;
    if (!native) return;
    const sessionId = session.log.sessionId;
    session.lastUsedAt = Date.now();
    const stored = await storeAttachments(sessionId, attachments);
    const app = native.kind === "app";
    // The window can only take text, so files are named by path (OG Coder
    // reads a path it is given, and turns an image path into an attachment).
    const whole = [text, ...stored.map((file) => file.path)]
      .filter((part) => part.length > 0)
      .join(" ");
    // The app takes text whole, line breaks and all; a terminal takes one line.
    const typed = app ? whole : typeable(whole);
    // Echoed now, as an ACP prompt is, so every client shows it at once; the
    // copy OG Coder writes to its file is then recognised and not repeated.
    this.send(
      session.log.append({
        kind: "user_message",
        text,
        ...(stored.length > 0 && {
          attachments: stored.map((file) => ({
            name: file.name,
            mimeType: file.mimeType,
            uri: file.path,
          })),
        }),
      }),
    );
    native.mirror.expectEcho(app ? text : typeable(text));
    this.nativeTurnStart(session);
    const ok = await native.typer.prompt(typed);
    if (!ok) {
      this.nativeTurnEnd(session);
      throw new Error(
        `The ${app ? "GG Coder app" : "OG Coder"} window on the computer didn't take the message. Is it still open?`,
      );
    }
  }

  async cancel(sessionId: string) {
    const session = this.require(sessionId);
    if (session.native) {
      await session.native.typer.cancel();
      return;
    }
    // A stop takes the queue with it: those messages go back to the composer
    // rather than running after the user said stop.
    if (session.working) session.cancelling = true;
    this.returnQueue(session);
    await session.ready;
    await session.handle!.cancel();
  }

  /**
   * Let go of a conversation's agent now, rather than when the reaper gets to
   * it.
   *
   * The same close `reapIdleSessions` performs, on demand. Everything true
   * there is true here: the process is the expensive part, the transcript is on
   * disk, and the conversation reopens by resuming — so this reclaims memory
   * without losing anything.
   *
   * A turn in flight is cancelled first rather than refused. The reaper skips a
   * working session because it cannot know whether the silence is a long tool
   * call, but a person tapping Close is saying they are done with it, and
   * closing the handle underneath a running turn would strand the app waiting
   * for a completion that can no longer arrive.
   *
   * Unknown ids are not an error. The session may have been reaped, or closed
   * on another device, and either way the caller's wish is already true —
   * `require` would throw an "Unknown session" the user cannot act on.
   *
   * @returns Whether a live session was actually closed.
   */
  async close(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.native) {
      // Never Esc into the user's window: stop mirroring and nothing else.
      this.closeSession(sessionId, session);
      this.announceProviders();
      return true;
    }

    if (session.working) {
      // Best effort: an agent that is already gone, or wedged, must not stop
      // this from reclaiming the process it is holding.
      try {
        await session.ready;
        await session.handle?.cancel();
      } catch {
        // Falls through to the close below, which is the point of the call.
      }
    }

    // The one close path (asks closed on every device, attachments discarded,
    // draft dropped), as the reaper uses.
    this.closeSession(sessionId, session);
    // The same announce the reaper and the session cap send, for the same
    // reason: `activeSessions` is how a client learns an id it still lists no
    // longer holds an agent, so the next prompt resumes instead of failing with
    // "Unknown session".
    this.announceProviders();
    return true;
  }

  /** An open ask stopped being open: forget it and log `ask_user_closed` once. */
  protected closeAsk(session: ActiveSession, requestId: string) {
    if (!session.asks?.delete(requestId)) return;
    this.record(session, { kind: "ask_user_closed", requestId });
  }

  /** Answer an open `_gg/ask_user` question. */
  answerAsk(sessionId: string, requestId: string, result: AskAnswer) {
    const session = this.require(sessionId);
    const answered = session.handle?.answerAsk(requestId, result) ?? false;
    if (answered) this.closeAsk(session, requestId);
    return answered;
  }

  answerPermission(sessionId: string, requestId: string, optionId: string) {
    const session = this.require(sessionId);
    const answered = session.handle?.answerPermission(requestId, optionId) ?? false;
    // Only on a real answer. A `false` means the connection had no such request
    // — a stale sheet from a previous turn, or a second client answering one
    // that was already resolved — and forgetting it here on that basis would
    // hide a *different*, still-open request from the next catch-up.
    if (answered && session.permissions?.delete(requestId)) this.touchInbox();
    this.awake.evaluate();
    return answered;
  }

  /**
   * Where this session's agent is running, for resolving the relative paths it
   * uses to name files. Undefined once the session is gone, in which case the
   * caller falls back to the daemon's own workspace.
   */
  /** Which provider a live session runs under, if any. */
  sessionProvider(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.providerId;
  }

  sessionCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  /**
   * Who ran this session and in which project, for the "agent finished"
   * notification.
   *
   * Only this machine has the path, and the phone must be able to name the
   * work even for a session it is not currently showing — which is exactly the
   * case a notification exists for.
   */
  sessionOrigin(sessionId: string): { providerId?: string; folder?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    return { providerId: session.providerId, folder: folderName(session.cwd) };
  }

  /**
   * Everything a push notification for a finished turn needs to say.
   *
   * Separate from `sessionOrigin` because the two have different audiences. That
   * one feeds `session.idle` on the wire, where the app resolves `providerId`
   * against the provider list it already holds. A push has no app to resolve
   * anything: the text is rendered by iOS with no JavaScript running, so the
   * agent's display name has to be looked up here.
   */
  sessionNotice(sessionId: string): { folder?: string; agentName?: string; lastText?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    return {
      folder: folderName(session.cwd),
      agentName: this.providers.find((p) => p.manifest.id === session.providerId)?.manifest.name,
      lastText: session.turnText,
    };
  }

  /** Replay everything a reconnecting client has not seen yet. */
  replay(sessionId: string, cursor: number): wire.SessionEvent[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    // Reading a conversation is using it. Without this, a session someone is
    // sitting in — scrolling, reading a long answer — aged out on the same
    // clock as one nobody had opened since breakfast.
    session.lastUsedAt = Date.now();
    return session.log.since(cursor);
  }

  /**
   * Frames that bring a reconnecting client level with what it missed.
   *
   * A phone loses its socket constantly — the screen locks, iOS suspends the
   * app, the radio switches from wifi to cellular, the relay drops a room. The
   * agent does not stop for any of that, and a frame sent while the socket is
   * down is gone: the relay stores nothing and `RelayClient.send` drops it.
   *
   * So the client names the highest `seq` it holds per session in its `hello`,
   * and this answers with the rest. Without it a phone that blinked mid-turn
   * silently resumed at the live edge, and the first thing the user saw was a
   * shell command from twenty seconds into work it had watched none of.
   *
   * Only sessions the client already knows about: a client is introduced to a
   * session by `session.started`, and an event for one it has never heard of
   * has nowhere to go. Cursors name exactly the sessions it has seen.
   */
  catchUp(cursors: Record<string, number>): wire.Replay[] {
    const frames: wire.Replay[] = [];
    for (const [sessionId, cursor] of Object.entries(cursors)) {
      const session = this.sessions.get(sessionId);
      // Not live means clients were never told it exists; replaying into that
      // would break the same invariant `markLive` exists to hold.
      if (!session || !session.live) continue;
      const events = this.replay(sessionId, cursor);
      const permissions = [...(session.permissions ?? [])].map(([requestId, params]) => ({
        requestId,
        params,
      }));
      // A client that missed nothing still needs the running flag: it may have
      // been away for the `session.idle` that ended the turn it last saw.
      //
      // Every known session gets a frame, including one with nothing to report.
      // "No events, not working, nothing pending" is not silence — it is the
      // answer that dismisses an approval sheet the user resolved at the desk
      // while this phone was away, and skipping it left that sheet up for ever,
      // wired to a requestId the daemon has already forgotten.
      frames.push({
        t: "session.replay",
        sessionId,
        events,
        complete: true,
        catchUp: true,
        working: session.working === true,
        // Always sent, empty array included. The app reads an *absent* field as
        // "an older daemon says nothing, leave any open sheet alone" and an
        // empty one as "nothing is pending, dismiss it" — so omitting it made
        // the second case unreachable.
        permissions,
        // Same absent/empty rule as permissions.
        queued: (session.queue ?? []).map(queuedForWire),
        asks: [...(session.asks ?? [])].map(([requestId, questions]) => ({
          requestId,
          questions: questions as wire.AskQuestion[],
        })),
        // Only a goal's coordinator has one; absent otherwise.
        ...(session.goal ? { goal: session.goal } : {}),
        ...(session.plan ? { plan: session.plan } : {}),
        ...(session.autopilot ? { autopilot: session.autopilot } : {}),
      });
    }
    return frames;
  }

  closeAll() {
    this.voiceController?.stop();
    this.appDesk.stop();
    if (this.chatWindowTimer) clearInterval(this.chatWindowTimer);
    this.chatWindowTimer = undefined;
    // The assertion must never outlive the daemon's sessions.
    this.awake.stop();
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
    for (const [sessionId, session] of [...this.sessions]) {
      this.closeSession(sessionId, session);
    }
    this.sessions.clear();
    for (const spare of this.spares.values()) {
      clearTimeout(spare.timer);
      spare.handle.close();
    }
    this.spares.clear();
  }

  protected require(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session '${sessionId}'`);
    return session;
  }
}

/** Said when the phone changes a selector OG Coder can't be driven to from outside. */
export const NATIVE_CONFIG_REFUSAL =
  "OG Coder switches plan mode itself, when it decides to plan (ask it to make a plan). It can't be switched from the phone.";

/** Said when the phone changes a selector on a conversation open in the GG Coder app. */
export const APP_CONFIG_REFUSAL =
  "The GG Coder app's model and thinking are set in its window. Change them there.";

const NATIVE_WINDOW_GONE = "The OG Coder window didn't take it. Is it still open?";

/** A turn this young is not ended by an idle-looking screen (it may not have redrawn yet). */
export const NATIVE_TURN_GRACE_MS = 4_000;

/** `from` on a draft typed at the desk, in OG Coder's own window. */
export const DESK_DRAFT_FROM = "desk";

/** How many steps forward through an option's values from current to `value`. */
export function cycleDistance(option: ConfigOption, value: string | boolean): number {
  const values = (option.options ?? []).map((o) => o.value);
  const from = values.indexOf(String(option.currentValue));
  const to = values.indexOf(String(value));
  if (from < 0 || to < 0) throw new Error(`'${String(value)}' isn't one of the choices`);
  return (to - from + values.length) % values.length;
}

function stopNative(native: NativeSession) {
  if (native.aliveTimer) clearInterval(native.aliveTimer);
  native.aliveTimer = undefined;
  if (native.readTimer) clearInterval(native.readTimer);
  native.readTimer = undefined;
  native.typer.stop();
  native.mirror.stop();
}
export { lastAgentLines } from "./voice/replies.js";

if (import.meta.main) {
  const daemon = new Daemon({ id: "local", name: "this machine" });
  daemon.attach((message) => console.log(JSON.stringify(message)));

  const { errors } = await daemon.refreshProviders();
  for (const error of errors) console.error(error.message);

  process.on("SIGINT", () => {
    daemon.closeAll();
    process.exit(0);
  });
}
