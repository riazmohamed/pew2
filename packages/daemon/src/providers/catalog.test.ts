import { describe, expect, test } from "bun:test";
import { catalogEnabled, catalogEntries, idsToToggle } from "./catalog";
import type { LoadedProvider } from "./registry";

function provider(id: string, extra: Partial<LoadedProvider> = {}, experimental = false): LoadedProvider {
  return {
    manifest: { id, name: id.toUpperCase(), pew: { experimental } } as unknown as LoadedProvider["manifest"],
    source: `/p/${id}.json`,
    command: id,
    args: [],
    missingEnv: [],
    commandMissing: false,
    ...extra,
  };
}

describe("catalogEntries", () => {
  test("lists disabled agents too, with whether each is installed and why not", () => {
    const entries = catalogEntries(
      [provider("claude-code"), provider("hermes", { commandMissing: true })],
      new Set(["hermes"]),
      false,
    );
    expect(entries).toEqual([
      { id: "claude-code", name: "CLAUDE-CODE", enabled: true, installed: true },
      { id: "hermes", name: "HERMES", enabled: false, installed: false, reason: "Not installed: 'hermes' is not on PATH" },
    ]);
  });

  test("hides the test agent unless experimental", () => {
    const list = [provider("echo", {}, true)];
    expect(catalogEntries(list, new Set(), false)).toEqual([]);
    expect(catalogEntries(list, new Set(), true).map((e) => e.id)).toEqual(["echo"]);
  });

  test("GG Goals reads as off while ggcoder is off", () => {
    const entries = catalogEntries([provider("ggcoder"), provider("gg-goals")], new Set(["ggcoder"]), false);
    expect(entries.map((e) => e.enabled)).toEqual([false, false]);
  });
});

describe("toggling", () => {
  test("GG Goals follows ggcoder", () => {
    expect(catalogEnabled("gg-goals", new Set())).toBe(true);
    expect(catalogEnabled("gg-goals", new Set(["ggcoder"]))).toBe(false);
    expect(catalogEnabled("gg-goals", new Set(["gg-goals"]))).toBe(false);
  });
  test("turning GG Goals on turns ggcoder on with it", () => {
    expect(idsToToggle("gg-goals", true)).toEqual(["gg-goals", "ggcoder"]);
    expect(idsToToggle("gg-goals", false)).toEqual(["gg-goals"]);
    expect(idsToToggle("ggcoder", false)).toEqual(["ggcoder"]);
  });
});
