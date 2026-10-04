/**
 * A line diff for the tool sheet.
 *
 * ACP hands an edit over as the file's old and new text, not as a patch, so the
 * phone has to draw the diff itself. Pure and Expo-free so it is testable.
 *
 * Common prefix and suffix are stripped first — nearly every agent edit is a
 * few lines in the middle of a file — and only the changed middle goes through
 * the LCS table, which is quadratic. simplification: a middle bigger than
 * `MAX_LCS_LINES` on either side is shown as all-removed then all-added rather
 * than aligned; a Myers diff is the upgrade if that ever reads badly.
 */

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

const MAX_LCS_LINES = 600;
/** Unchanged lines kept either side of a change, as a patch would. */
const CONTEXT = 3;

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "same", text: a[i]! });
  out.push(...middle(a.slice(start, endA), b.slice(start, endB)));
  for (let i = endA; i < a.length; i++) out.push({ kind: "same", text: a[i]! });
  return out;
}

function middle(a: string[], b: string[]): DiffLine[] {
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [
      ...a.map((text) => ({ kind: "del", text }) as const),
      ...b.map((text) => ({ kind: "add", text }) as const),
    ];
  }
  // Standard LCS table; walked back from the corner to emit the edit script.
  const n = a.length;
  const m = b.length;
  const table = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        a[i] === b[j]
          ? table[at(i + 1, j + 1)]! + 1
          : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) {
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: "del", text: a[i]! });
  for (; j < m; j++) out.push({ kind: "add", text: b[j]! });
  return out;
}

/**
 * Only the changed lines plus a few of context, with a marker where unchanged
 * stretches were cut — a whole file with three lines touched is otherwise a
 * scroll to find them.
 */
export function hunks(lines: DiffLine[]): (DiffLine | { kind: "skip"; count: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k++) {
      keep[k] = true;
    }
  });
  const out: (DiffLine | { kind: "skip"; count: number })[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) out.push({ kind: "skip", count: skipped });
      skipped = 0;
      out.push(line);
    } else skipped++;
  });
  if (skipped > 0) out.push({ kind: "skip", count: skipped });
  return out;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline is the file's terminator, not an empty last line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
