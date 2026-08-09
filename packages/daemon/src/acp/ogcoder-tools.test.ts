import { expect, test } from "bun:test";
import { toolKind, toolTitle } from "./ogcoder-tools.js";

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
