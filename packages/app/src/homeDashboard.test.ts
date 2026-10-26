import { describe, expect, it } from "bun:test";
import {
  HOME_CARDS,
  homeDashboard,
  homeLayoutCards,
  homeLink,
  homeMessage,
  parseHomeCards,
} from "./homeDashboard";
import type { WidgetInput } from "./widgetSnapshot";

const providers = [{ id: "claude", name: "Claude Code", color: "#D97757" }];

function session(id: string, extra: Partial<WidgetInput["sessions"][number]> = {}) {
  return {
    id,
    providerId: "claude",
    title: `Chat ${id}`,
    folder: "pew2",
    startedAt: 1000,
    ...extra,
  };
}

describe("homeDashboard", () => {
  it("one card per recent conversation, needs-you first, then newest", () => {
    const home = homeDashboard({
      sessions: [
        session("old", { startedAt: 100 }),
        session("new", { startedAt: 900 }),
        session("busy", { busy: true, startedAt: 500 }),
        session("perm", { permission: { title: "Run npm test" }, startedAt: 50 }),
        session("ask", { startedAt: 40 }),
      ],
      asks: { ask: [{ questions: [{ question: "Which  branch?" }] }] },
      providers,
    });
    expect(home.cards.slice(0, 2).map((card) => [card.id, card.line])).toEqual([
      ["perm", "Run npm test"],
      ["ask", "Which branch?"],
    ]);
    expect(home.cards.slice(2).map((card) => card.id)).toEqual(["new", "busy", "old"]);
    expect(home.cards.length).toBeLessThanOrEqual(6);
    expect(home.cards.find((card) => card.id === "busy")?.state).toBe("working");
    expect(home.cards[0]?.agent).toBe("Claude Code");
    expect(home.empty).toBe(false);
  });

  it("keeps it short", () => {
    const sessions = Array.from({ length: HOME_CARDS + 5 }, (_, i) =>
      session(`s${i}`, { startedAt: 1000 - i }),
    );
    const home = homeDashboard({ sessions, asks: {}, providers });
    expect(home.cards).toHaveLength(HOME_CARDS);
    expect(home.cards[0]?.id).toBe("s0");
  });

  it("nothing yet is the empty state", () => {
    expect(homeDashboard({ sessions: [], asks: {}, providers })).toEqual({
      cards: [],
      empty: true,
    });
  });
});

it("remembers how many cards home showed, within the limit", () => {
  expect(parseHomeCards("4")).toBe(4);
  expect(parseHomeCards("99")).toBe(HOME_CARDS);
  expect(parseHomeCards("0")).toBe(0);
  expect(parseHomeCards(null)).toBeUndefined();
  expect(parseHomeCards("x")).toBeUndefined();
});

describe("home while the connection comes and goes", () => {
  const base = { agents: 2, empty: false, hasCards: true };

  it("re-dialling is connecting, not offline: the app says can't reach only once retries stall", () => {
    expect(homeLink("connecting", false)).toBe("connecting");
    expect(homeLink("offline", false)).toBe("connecting");
    expect(homeLink("online", false)).toBe("online");
    expect(homeLink("offline", true)).toBe("unreachable");
  });

  it("says nothing while re-dialling with the cards up, so nothing under Pew changes on every return", () => {
    expect(homeMessage({ ...base, link: "connecting" })).toBeUndefined();
    expect(homeMessage({ ...base, link: "unreachable" })?.title).toBe("Can't reach your computer");
  });

  it("with nothing to show yet, says it is connecting rather than that it failed", () => {
    expect(homeMessage({ ...base, hasCards: false, link: "connecting" })?.title).toBe(
      "Connecting…",
    );
  });

  it("a refusal outranks everything", () => {
    expect(homeMessage({ ...base, link: "online", fatal: "rotated" })?.title).toBe("Can't connect");
  });
});

describe("homeLayoutCards", () => {
  it("lays out for last time's cards before anything has arrived", () => {
    expect(homeLayoutCards({ known: 0, remembered: 6 })).toBe(6);
  });

  it("never drops to a smaller layout because one agent's list landed first", () => {
    expect(homeLayoutCards({ known: 2, remembered: 6 })).toBe(6);
  });

  it("does not shrink during a launch even when the answer is fewer", () => {
    // Fewer cards leave space under them; the next launch is laid out for it.
    expect(homeLayoutCards({ known: 0, remembered: 6 })).toBe(6);
  });

  it("grows for more cards than last time, and starts empty on a first launch", () => {
    expect(homeLayoutCards({ known: 4, remembered: 2 })).toBe(4);
    expect(homeLayoutCards({ known: 0, remembered: undefined })).toBe(0);
  });
});
