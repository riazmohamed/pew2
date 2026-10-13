/**
 * Live draft mirroring (`session.draft`) — the pure half. Expo-free so it is
 * bun-tested; `useDaemon.ts` and the dock do the wiring.
 */

/** Trailing throttle for keystroke-rate drafts. */
export const DRAFT_THROTTLE_MS = 80;

/**
 * Whether a draft may go out at all.
 *
 * `drafts` must be exactly `true`: an older daemon never announces it, and it
 * answers an unknown type with `unknown_message`, which this app reads as a
 * refused push token. Ungated drafts would silence notifications.
 */
export function shouldSendDraft(socketOpen: boolean, drafts: boolean | undefined): boolean {
  return socketOpen && drafts === true;
}

export interface RemoteDraft {
  sessionId?: string;
  text: string;
  from?: string;
}

/**
 * Whether a draft from the daemon belongs in this composer: not our own echo,
 * for the conversation on screen (both absent = the not-yet-started one).
 */
export function shouldApplyRemoteDraft(
  draft: RemoteDraft,
  ownDeviceId: string,
  onScreenSessionId: string | undefined,
): boolean {
  if (typeof draft.text !== "string") return false;
  if (draft.from !== undefined && draft.from === ownDeviceId) return false;
  return (draft.sessionId ?? undefined) === (onScreenSessionId ?? undefined);
}

/**
 * Whether the composer should take the remote text. Never while dictating —
 * the recogniser owns the draft then and would be overwritten mid-sentence —
 * and not when it already matches.
 */
export function shouldReplaceDraft(remote: string, current: string, dictating: boolean): boolean {
  return !dictating && remote !== current;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface DraftThrottle {
  push(text: string): void;
  cancel(): void;
}

/**
 * Trailing throttle: at most one send per `ms`, always ending on the latest
 * text. An empty draft goes immediately (a clear must not lag a keystroke).
 */
export function createDraftThrottle(
  send: (text: string) => void,
  timers: Timers,
  ms: number = DRAFT_THROTTLE_MS,
): DraftThrottle {
  let pending: string | undefined;
  let handle: unknown;
  const flush = () => {
    handle = undefined;
    if (pending === undefined) return;
    const text = pending;
    pending = undefined;
    send(text);
    handle = timers.set(flush, ms);
  };
  return {
    push(text) {
      if (text === "") {
        if (handle !== undefined) timers.clear(handle);
        handle = undefined;
        pending = undefined;
        send("");
        return;
      }
      pending = text;
      if (handle === undefined) flush();
    },
    cancel() {
      if (handle !== undefined) timers.clear(handle);
      handle = undefined;
      pending = undefined;
    },
  };
}
