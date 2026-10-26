import { describe, expect, test } from "bun:test";
import { agentNote, agentRows, applyToggle, type CatalogEntry } from "./agentSettings";

const catalog: CatalogEntry[] = [
  {
    id: "hermes",
    name: "Hermes",
    enabled: true,
    installed: false,
    reason: "Not installed: 'hermes' is not on PATH",
  },
  { id: "ggcoder", name: "OG Coder", enabled: true, installed: true },
  { id: "gg-goals", name: "GG Goals", enabled: true, installed: true },
  { id: "claude-code", name: "Claude Code", enabled: false, installed: true },
];

describe("agentRows", () => {
  test("no catalog (older daemon) means no rows", () => {
    expect(agentRows(undefined)).toEqual([]);
  });
  test("installed first, otherwise in order", () => {
    expect(agentRows(catalog).map((e) => e.id)).toEqual([
      "ggcoder",
      "gg-goals",
      "claude-code",
      "hermes",
    ]);
  });
});

describe("applyToggle", () => {
  test("flips one row", () => {
    expect(
      applyToggle(catalog, "claude-code", true).find((e) => e.id === "claude-code")?.enabled,
    ).toBe(true);
  });
  test("OG Coder off takes GG Goals with it", () => {
    const next = applyToggle(catalog, "ggcoder", false);
    expect(next.find((e) => e.id === "gg-goals")?.enabled).toBe(false);
  });
  test("GG Goals on turns OG Coder on", () => {
    const off = catalog.map((e) =>
      e.id === "ggcoder" || e.id === "gg-goals" ? { ...e, enabled: false } : e,
    );
    const next = applyToggle(off, "gg-goals", true);
    expect(next.filter((e) => e.enabled).map((e) => e.id)).toEqual([
      "hermes",
      "ggcoder",
      "gg-goals",
    ]);
  });
});

test("agentNote says why an agent cannot run", () => {
  expect(agentNote(catalog[0]!)).toContain("Not installed");
  expect(agentNote({ id: "x", name: "X", enabled: true, installed: false })).toBe(
    "Not installed on this computer.",
  );
  expect(agentNote(catalog[1]!)).toBeUndefined();
});
