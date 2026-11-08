/**
 * Share one in-flight request between identical asks.
 *
 * Opening a conversation on the computer can take several seconds (iTerm's
 * first-run prompt, a new GG Coder window), and nothing on the phone changes
 * meanwhile, so a second or third tap sent the same request again: three
 * `pew2 chat` windows from one intent (8 Nov, three "new chat in tmc_fms_web"
 * within a second). A repeat while the first is still waiting now gets the
 * first one's answer instead of a request of its own.
 */
export function shareInFlight<T>(
  live: Map<string, Promise<T>>,
  key: string,
  make: () => Promise<T>,
): Promise<T> {
  const pending = live.get(key);
  if (pending) return pending;
  const started = make().finally(() => {
    if (live.get(key) === started) live.delete(key);
  });
  live.set(key, started);
  return started;
}
