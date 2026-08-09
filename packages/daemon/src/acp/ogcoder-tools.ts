/**
 * Naming GG Coder's tool calls for an ACP client.
 *
 * ACP asks for a `kind` and a `title` per tool call; GG Coder's `--rpc` stream
 * offers a bare tool name and an argument bag. Both mappings are guesses, so
 * they live here rather than inside the bridge's socket loop — a guess that can
 * be tested is a guess that can be corrected.
 */

/** The tool kinds ACP clients render distinctly. */
export type ToolKind = "read" | "search" | "edit" | "execute" | "fetch" | "other";

/**
 * Infer an ACP tool kind from a GG Coder tool name.
 *
 * The phone draws an icon and an activity verb from this, so a wrong answer is
 * visible rather than merely inaccurate. Anything unrecognised stays `other`:
 * an unknown tool shown as "Editing" would be a lie about what the agent is
 * doing to the user's files, which is the one thing an approval UI must not do.
 */
export function toolKind(name: string): ToolKind {
  const lower = name.toLowerCase();
  // Order matters: `read_file` and `grep_files` both contain "file", and edits
  // are checked before reads because `write` beats a merely suggestive noun.
  if (/(edit|write|patch|apply|create|delete|remove)/.test(lower)) return "edit";
  if (/(grep|search|find|glob)/.test(lower)) return "search";
  if (/(bash|shell|exec|run|command|terminal)/.test(lower)) return "execute";
  if (/(fetch|http|web|browse|curl)/.test(lower)) return "fetch";
  if (/(read|cat|view|ls|list)/.test(lower)) return "read";
  return "other";
}

/** Longest title we send. Past this a phone truncates mid-word anyway. */
const TITLE_LIMIT = 80;

/**
 * A one-line title for a tool call.
 *
 * The first non-empty string argument is nearly always the interesting one — a
 * path, a pattern, a command — and including it is the difference between
 * "Bash" and "Bash: bun test", i.e. between knowing the agent is busy and
 * knowing what it is busy with.
 *
 * Whitespace is flattened because a multi-line shell script in a title breaks
 * the client's single-line activity row.
 */
export function toolTitle(name: string, args?: Record<string, unknown>): string {
  const first = Object.values(args ?? {}).find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (typeof first !== "string") return name;
  const flat = first.replace(/\s+/g, " ").trim();
  const clipped = flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT - 1)}…` : flat;
  return `${name}: ${clipped}`;
}
