import { expect, test } from "bun:test";
import { hunks, lineDiff } from "./lineDiff";

const kinds = (old: string, next: string) => lineDiff(old, next).map((l) => `${l.kind}:${l.text}`);

test("an edit in the middle keeps the rest as context", () => {
  expect(kinds("a\nb\nc\nd\n", "a\nB\nc\nd\n")).toEqual(["same:a", "del:b", "add:B", "same:c", "same:d"]);
});

test("an insertion and a deletion", () => {
  expect(kinds("a\nb\n", "a\nx\nb\n")).toEqual(["same:a", "add:x", "same:b"]);
  expect(kinds("a\nx\nb\n", "a\nb\n")).toEqual(["same:a", "del:x", "same:b"]);
});

test("a new file is all additions, a deleted one all removals", () => {
  expect(kinds("", "a\nb\n")).toEqual(["add:a", "add:b"]);
  expect(kinds("a\n", "")).toEqual(["del:a"]);
});

test("identical text is all context", () => {
  expect(kinds("a\nb", "a\nb")).toEqual(["same:a", "same:b"]);
});

test("a huge rewrite still answers, unaligned", () => {
  const old = Array.from({ length: 2000 }, (_, i) => `o${i}`).join("\n");
  const next = Array.from({ length: 2000 }, (_, i) => `n${i}`).join("\n");
  const lines = lineDiff(old, next);
  expect(lines.length).toBe(4000);
  expect(lines[0]).toEqual({ kind: "del", text: "o0" });
  expect(lines[3999]).toEqual({ kind: "add", text: "n1999" });
});

test("hunks cut long unchanged stretches down to three lines of context", () => {
  const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const next = old.replace("l10", "L10");
  const out = hunks(lineDiff(old, next));
  expect(out[0]).toEqual({ kind: "skip", count: 7 });
  expect(out.slice(1, 4).map((l) => l.kind)).toEqual(["same", "same", "same"]);
  expect(out[4]).toEqual({ kind: "del", text: "l10" });
  expect(out[5]).toEqual({ kind: "add", text: "L10" });
  expect(out[out.length - 1]).toEqual({ kind: "skip", count: 6 });
});
