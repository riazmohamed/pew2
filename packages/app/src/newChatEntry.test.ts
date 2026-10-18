import { describe, expect, test } from "bun:test";
import { openingStep, projectPillAction } from "./newChatEntry";

describe("openingStep", () => {
  test("opens at the browser only when asked and the daemon can browse", () => {
    expect(openingStep(true, true)).toBe("browse");
    expect(openingStep(true, false)).toBe("choices");
    expect(openingStep(false, true)).toBe("choices");
  });
});

describe("projectPillAction", () => {
  test("an empty new conversation chooses a project", () => {
    expect(projectPillAction({ loadingSession: false, goals: false })).toBe("choose");
  });
  test("inside a conversation it shows the details", () => {
    expect(projectPillAction({ sessionId: "s1", loadingSession: false, goals: false })).toBe("details");
  });
  test("a conversation still reopening is not a new one", () => {
    expect(projectPillAction({ loadingSession: true, goals: false })).toBe("details");
  });
  test("GG Goals keeps the details: it has no free-standing chat", () => {
    expect(projectPillAction({ loadingSession: false, goals: true })).toBe("details");
  });
});
