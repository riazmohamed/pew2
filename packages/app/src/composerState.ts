/**
 * When the composer offers to stop the agent.
 *
 * Split out and tested because getting it wrong is invisible to types and
 * obvious to the user: reopening a past conversation sets `busy` while its
 * history loads, and every agent that replays over ACP takes a couple of
 * seconds to do it. For that window the composer showed a stop button for a
 * turn nobody had started, and pressing it cancelled a session that was not
 * running.
 *
 * It looked fine in testing because Claude Code and ggcoder read their history
 * straight off local disk and arrive too fast to notice.
 */
export function showsStop(state: { busy: boolean; loadingSession: boolean }): boolean {
  return state.busy && !state.loadingSession;
}

/**
 * Whether the composer's button stops the turn rather than sends.
 *
 * Only with nothing to send: a running turn is no reason to refuse a message
 * — the daemon queues it for the agent's next step (`session.queue`).
 */
export function pressStops(state: { busy: boolean; canSend: boolean }): boolean {
  return state.busy && !state.canSend;
}

/**
 * The composer's placeholder when the link to the computer is not up, or
 * undefined when it is (the normal prompt applies). Connecting is not offline:
 * only a link given up on says sends are queued, and a refusal reconnecting
 * cannot fix (`fatal`, the input locked) says why instead.
 */
export function connectionPlaceholder(state: {
  status: "connecting" | "online" | "offline";
  unreachable?: boolean;
  fatal?: string;
}): string | undefined {
  if (state.fatal) return state.fatal;
  if (state.status === "online") return undefined;
  if (state.status === "connecting" && !state.unreachable) return "Connecting…";
  return "Offline. Sends when you reconnect";
}
