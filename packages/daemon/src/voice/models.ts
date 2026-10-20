/**
 * Models by voice: matching what someone says ("GPT", "sonnet", "kimi") to
 * an agent's model menu, and spotting a turn that stopped on a usage limit.
 *
 * Pure, so `bun test` runs it. `tools.ts` drives it through the port.
 */

export interface ModelChoice {
  value: string;
  name?: string;
}

/** Spoken words for a model ("gpt six point one sol" -> "gpt61sol"). */
const squash = (text: string) =>
  text
    .toLowerCase()
    .replace(/\bpoint\b/g, "")
    .replace(/\bone\b(?=\s*(sol|astra|luna|\d))/g, "1")
    .replace(/\b(the|model|use|switch|to|please|one|on)\b/g, " ")
    .replace(/\bsix\b/g, "6")
    .replace(/\bfive\b/g, "5")
    .replace(/\bfour\b/g, "4")
    .replace(/[^a-z0-9]+/g, "");

/**
 * Families people name by maker or nickname rather than the menu's ids.
 * The first id in the menu matching a family's pattern is its default.
 */
const FAMILIES: { said: RegExp; id: RegExp }[] = [
  { said: /^(gpt|openai|chatgpt|codex)$/, id: /^gpt-[\d.]+-[a-z]+$/ },
  { said: /^(claude|anthropic)$/, id: /^claude-|^(opus|sonnet)$/ },
  { said: /^(gemini|google)$/, id: /^gemini-/ },
  { said: /^(kimi|moonshot)$/, id: /^kimi-/ },
  { said: /^(glm|zhipu)$/, id: /^glm-/ },
  { said: /^(deepseek)$/, id: /deepseek/ },
  { said: /^(grok|xai)$/, id: /^grok-/ },
  { said: /^(qwen)$/, id: /qwen/ },
];

/**
 * The model a spoken name means, from the agent's own menu.
 *
 * Exact (squashed) id or name first; then a family word ("gpt" -> the menu's
 * first plain GPT); then the one model whose id contains what was said. More
 * than one partial match is a question, not a guess.
 */
export function matchModel(
  said: string,
  options: readonly ModelChoice[],
): { kind: "found"; model: ModelChoice } | { kind: "ambiguous"; options: ModelChoice[] } | { kind: "none" } {
  const want = squash(said);
  if (!want) return { kind: "none" };
  const keys = (option: ModelChoice) => [squash(option.value), squash(option.name ?? "")].filter(Boolean);
  const exact = options.find((option) => keys(option).includes(want));
  if (exact) return { kind: "found", model: exact };
  const family = FAMILIES.find((entry) => entry.said.test(want));
  if (family) {
    const first = options.find((option) => family.id.test(option.value));
    if (first) return { kind: "found", model: first };
  }
  const partial = options.filter((option) => keys(option).some((key) => key.includes(want)));
  if (partial.length === 1) return { kind: "found", model: partial[0]! };
  if (partial.length > 1) {
    // "sol" matches gpt-6.1-sol and gpt-6.1-sol-fast: the shortest id is the plain one.
    const sorted = [...partial].sort((a, b) => a.value.length - b.value.length);
    if (sorted.every((option) => option.value.startsWith(sorted[0]!.value))) return { kind: "found", model: sorted[0]! };
    return { kind: "ambiguous", options: partial.slice(0, 4) };
  }
  return { kind: "none" };
}

/** A model the user can switch to when Claude's limit is hit: the menu's first plain GPT. */
export function fallbackModel(options: readonly ModelChoice[]): ModelChoice | undefined {
  return options.find((option) => /^gpt-[\d.]+-[a-z]+$/.test(option.value)) ?? options.find((option) => !/claude|opus|sonnet|haiku|fable/i.test(option.value));
}

/**
 * Whether an agent's closing lines say it stopped on a usage or rate limit.
 * Claude Code says "You've hit your session limit · resets 8:50pm"; others
 * say "rate limit", "usage limit", "quota", "429", "overloaded".
 */
export function hitLimit(lines: readonly string[]): string | undefined {
  const text = lines.slice(-4).join(" ");
  const match = /(you'?ve hit your [a-z ]*limit[^.\n]*|usage limit[^.\n]*|rate[ _-]?limit[^.\n]*|quota (exceeded|reached)[^.\n]*|out of credits[^.\n]*|\b429\b[^.\n]*|overloaded[^.\n]*)/i.exec(text);
  return match ? match[0].trim().slice(0, 160) : undefined;
}
