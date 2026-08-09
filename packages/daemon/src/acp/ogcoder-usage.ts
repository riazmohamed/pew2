/**
 * Turning GG Coder's token counts into the app's context meter.
 *
 * The app reads a `usage_update` carrying `used` and `size`, and shows nothing
 * at all when either is absent — its own harness lists "No usage — GG Coder
 * today" as a case it must survive. The numbers exist; they were simply never
 * mapped.
 *
 * Two judgement calls, both visible on screen if wrong:
 *
 *   1. **Cached tokens count as used.** With prompt caching, `inputTokens` is
 *      only the *uncached* remainder — the conversation still occupies the
 *      window whether or not the provider re-read it. Counting inputs alone
 *      makes a long thread read as nearly empty right up until it is
 *      compacted, which is the opposite of a warning.
 *   2. **The window comes from the model, not the turn.** A turn knows what it
 *      spent, not what it was allowed. Without the model's `contextWindow`
 *      there is no denominator, and a meter with a guessed one is worse than
 *      no meter.
 */

/** The token counts GG Coder reports at the end of a turn. */
export interface RpcUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** What the app's context bar needs. */
export interface ContextUsage {
  used: number;
  size: number;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Tokens occupying the context window after a turn.
 *
 * Cache reads and writes are included because they are conversation content;
 * see the note above on why leaving them out under-reports a long thread.
 */
export function tokensUsed(usage: RpcUsage | undefined): number {
  if (!usage) return 0;
  return (
    finite(usage.inputTokens) +
    finite(usage.outputTokens) +
    finite(usage.cacheRead) +
    finite(usage.cacheWrite)
  );
}

/**
 * A `usage_update` payload, or `undefined` when the meter would be a guess.
 *
 * Returning `undefined` rather than a zeroed reading is deliberate: the app
 * omits the row when usage is absent, and an honest gap beats a meter that
 * confidently reads 0% while tokens are plainly being spent.
 */
export function usageUpdate(
  usage: RpcUsage | undefined,
  contextWindow: number | undefined,
): (ContextUsage & { sessionUpdate: "usage_update" }) | undefined {
  const used = tokensUsed(usage);
  const size = finite(contextWindow);
  if (used <= 0 || size <= 0) return undefined;
  return { sessionUpdate: "usage_update", used, size };
}
