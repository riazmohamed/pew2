import { describe, expect, test } from "bun:test";
import { matchesProjectQuery, searchProjects } from "./projectSearch";

describe("matchesProjectQuery", () => {
  test("empty and bare wildcard match everything", () => {
    expect(matchesProjectQuery("pew2", "")).toBe(true);
    expect(matchesProjectQuery("pew2", "  ")).toBe(true);
    expect(matchesProjectQuery("pew2", "**")).toBe(true);
  });
  test("case-insensitive substring", () => {
    expect(matchesProjectQuery("TMC_FMS_Web", "fms")).toBe(true);
    expect(matchesProjectQuery("tmc_fms_web", "FMS_W")).toBe(true);
    expect(matchesProjectQuery("tmc_fms_web", "xyz")).toBe(false);
  });
  test("wildcard joins parts in order", () => {
    expect(matchesProjectQuery("tmc_fms_web", "tmc*web")).toBe(true);
    expect(matchesProjectQuery("tmc_fms_web", "web*tmc")).toBe(false);
    expect(matchesProjectQuery("tmc_fms_web", "*fms*")).toBe(true);
    expect(matchesProjectQuery("tmc_fms_automation", "tmc*web")).toBe(false);
  });
  test("parts do not overlap", () => {
    expect(matchesProjectQuery("abc", "ab*bc")).toBe(false);
    expect(matchesProjectQuery("abbc", "ab*bc")).toBe(true);
  });
});

describe("searchProjects", () => {
  const projects = [
    { name: "pew2", path: "/u/unstablemind/pew2" },
    { name: "tmc_fms_web", path: "/u/tmc/tmc_fms_web" },
    { name: "tmc_fms_automation", path: "/u/tmc/tmc_fms_automation" },
    { name: "notes", path: "/u/unstablemind/notes" },
  ];
  test("empty query keeps order", () => {
    expect(searchProjects(projects, "").map((p) => p.name)).toEqual([
      "pew2",
      "tmc_fms_web",
      "tmc_fms_automation",
      "notes",
    ]);
  });
  test("filters by wildcard, preserving order", () => {
    expect(searchProjects(projects, "tmc*").map((p) => p.name)).toEqual([
      "tmc_fms_web",
      "tmc_fms_automation",
    ]);
    expect(searchProjects(projects, "tmc*web").map((p) => p.name)).toEqual(["tmc_fms_web"]);
  });
  test("name matches lead path matches", () => {
    expect(searchProjects(projects, "unstable").map((p) => p.name)).toEqual(["pew2", "notes"]);
    const mixed = [
      { name: "alpha", path: "/x/notes/alpha" },
      { name: "notes", path: "/y/notes" },
    ];
    expect(searchProjects(mixed, "notes").map((p) => p.name)).toEqual(["notes", "alpha"]);
  });
});
