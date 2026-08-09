import { expect, test } from "bun:test";
import { toolContent, toolKind, toolTitle } from "./ogcoder-tools.js";

test("edit-shaped names win over the nouns they contain", () => {
  // `write_file` contains "file" and `read` — the danger is classifying a write
  // as a read, which shows the user a passive icon for a destructive action.
  expect(toolKind("write_file")).toBe("edit");
  expect(toolKind("apply_patch")).toBe("edit");
  expect(toolKind("delete_file")).toBe("edit");
});

test("the remaining kinds map from their obvious names", () => {
  expect(toolKind("read_file")).toBe("read");
  expect(toolKind("grep")).toBe("search");
  expect(toolKind("Bash")).toBe("execute");
  expect(toolKind("web_fetch")).toBe("fetch");
});

test("an unknown tool is 'other', not a guess", () => {
  expect(toolKind("summon_kraken")).toBe("other");
  expect(toolKind("")).toBe("other");
});

test("the first string argument becomes the title", () => {
  expect(toolTitle("Bash", { command: "bun test", timeout: 5000 })).toBe("Bash: bun test");
});

test("non-string and blank arguments are skipped, not shown", () => {
  // A title of "Read: 42" names nothing the user can act on.
  expect(toolTitle("Read", { limit: 42 })).toBe("Read");
  expect(toolTitle("Read", { path: "   " })).toBe("Read");
  expect(toolTitle("Read", {})).toBe("Read");
  expect(toolTitle("Read")).toBe("Read");
});

test("a multi-line argument is flattened to one line", () => {
  // A heredoc in a shell command would otherwise break the activity row.
  expect(toolTitle("Bash", { command: "set -e\n\n  echo hi" })).toBe("Bash: set -e echo hi");
});

test("a long argument is clipped with an ellipsis, not sent whole", () => {
  const long = "a".repeat(500);
  const title = toolTitle("Bash", { command: long });
  expect(title.length).toBe("Bash: ".length + 80);
  expect(title.endsWith("…")).toBe(true);
});

test("a bare string result becomes tool content", () => {
  expect(toolContent("hello\nworld")).toEqual({
    content: [{ type: "content", content: { type: "text", text: "hello\nworld" } }],
  });
});

test("progress objects are read from whichever field carries the text", () => {
  // GG Coder sends a bare string for a result and `{ type, output }` for
  // progress; assuming one shape silently drops the other.
  expect(toolContent({ type: "bash_progress", output: "line 1" })).toEqual({
    content: [{ type: "content", content: { type: "text", text: "line 1" } }],
  });
});

test("nothing worth showing yields an empty object, not empty content", () => {
  // Callers spread this unconditionally, so it must be safe to be absent.
  expect(toolContent(undefined)).toEqual({});
  expect(toolContent("   ")).toEqual({});
  expect(toolContent({ type: "progress" })).toEqual({});
  expect(toolContent(42)).toEqual({});
});

test("huge output is clipped before it crosses the relay", () => {
  // A bash call can emit megabytes, and every byte reaches a phone.
  const result = toolContent("x".repeat(50_000));
  const text = (result.content?.[0]?.content as { text: string }).text;
  expect(text.length).toBeLessThan(4_100);
  expect(text.endsWith("… (truncated)")).toBe(true);
});
