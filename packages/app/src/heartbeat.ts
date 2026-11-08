/**
 * The steady connection check while the app is open and connected.
 *
 * A network lost under a socket (out of signal, wifi to cellular) can leave it
 * half open: nothing arrives, nothing fails, `onclose` never runs, and the
 * hello that replays missed replies by cursor is never sent. The foreground
 * probe in `daemonConnection.ts` only catches this on return to the app.
 *
 * After {@link IDLE_PING_MS} of silence this sends the cleartext keepalive the
 * relay and the LAN server already answer; after {@link DEAD_AFTER_MS} of
 * silence it reports the socket dead, so it is replaced. No new frame: an old
 * daemon is spoken to exactly as before.
 *
 * Only a socket that has answered a ping can be judged by one. Until a pong
 * arrives, an unanswered ping stops the check instead of reconnecting, so a
 * far end that never answers pings (an older LAN daemon) cannot cause a
 * reconnect loop. One timer at a time, rescheduled from the last frame heard
 * rather than reset on every frame, so a busy stream costs nothing.
 */

/** The relay's and the LAN server's answer to the keepalive, byte for byte. */
export const KEEPALIVE_REPLY = '{"t":"pong"}';

/** Silence before the keepalive goes out. */
export const IDLE_PING_MS = 15_000;
/** Silence after which a socket that answers pings is given up on. */
export const DEAD_AFTER_MS = 40_000;

export interface HeartbeatDeps {
  /** Send the keepalive. False if it could not be written. */
  send: () => boolean;
  /** The socket is dead: replace it. */
  dead: (why: string) => void;
  now: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface Heartbeat {
  /** Begin (idempotent). Sends one ping at once, to learn whether pings are answered. */
  start: () => void;
  /** Stop: no timer left behind. */
  stop: () => void;
  /** Any frame arrived. `pong` when it was the keepalive's answer. */
  heard: (pong: boolean) => void;
  readonly running: boolean;
}

export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  let timer: unknown;
  let running = false;
  let lastHeard = 0;
  let pinged = false;
  let answers = false;

  const schedule = (ms: number) => {
    deps.clearTimer(timer);
    timer = deps.setTimer(tick, Math.max(ms, 0));
  };

  const ping = (): boolean => {
    pinged = true;
    if (deps.send()) return true;
    stop();
    deps.dead("keepalive could not be sent");
    return false;
  };

  const tick = () => {
    timer = undefined;
    if (!running) return;
    const silent = deps.now() - lastHeard;
    if (pinged && silent >= DEAD_AFTER_MS) {
      stop();
      // Never answered a ping: the far end does not, so silence proves nothing.
      if (answers) deps.dead("no answer to the keepalive");
      return;
    }
    if (!pinged && silent >= IDLE_PING_MS) {
      if (!ping()) return;
      schedule(DEAD_AFTER_MS - silent);
      return;
    }
    schedule((pinged ? DEAD_AFTER_MS : IDLE_PING_MS) - silent);
  };

  function stop() {
    running = false;
    deps.clearTimer(timer);
    timer = undefined;
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastHeard = deps.now();
      if (!ping()) return;
      schedule(DEAD_AFTER_MS);
    },
    stop,
    heard(pong) {
      if (pong) answers = true;
      lastHeard = deps.now();
      if (!pinged || !running) return;
      pinged = false;
      schedule(IDLE_PING_MS);
    },
    get running() {
      return running;
    },
  };
}
