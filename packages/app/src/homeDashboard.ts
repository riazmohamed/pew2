/**
 * Home: cards for the last conversations, nothing else. One that needs you
 * (an approval or question) comes first, then the newest. Each card carries
 * its own state, so "needs you" and "working" show on the card instead of in
 * sections of their own.
 *
 * Built on `widgetRows`, so home and the home-screen widget agree about every
 * conversation's state. Pure and Expo-free (tested under bun).
 */
import { widgetRows, type WidgetInput, type WidgetRow } from "./widgetSnapshot";

/** Cards on home. A short window of recent work, not the full history (that is the drawer). */
export const HOME_CARDS = 6;

export interface DashboardCard extends WidgetRow {
  /** One line under the title: the approval or question, when there is one. */
  line?: string;
}

export interface HomeDashboard {
  cards: DashboardCard[];
  /** No conversation at all: the fresh-pairing empty state. */
  empty: boolean;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** The permission's title, else the first question asked. */
function needsLine(permission: unknown, asks: readonly unknown[] | undefined): string | undefined {
  const title = text(field(permission, "title"));
  if (title) return title;
  const first = asks?.[0];
  const questions = field(first, "questions");
  const question = Array.isArray(questions) ? text(field(questions[0], "question")) : undefined;
  return question ?? (asks && asks.length > 0 ? "Question" : undefined);
}

export function homeDashboard(input: WidgetInput): HomeDashboard {
  const byId = new Map(input.sessions.map((session) => [session.id, session]));
  const rows = widgetRows(input);
  const cards: DashboardCard[] = rows.map((row) => {
    if (row.state !== "waiting") return row;
    const line = needsLine(byId.get(row.id)?.permission, input.asks[row.id]);
    return line ? { ...row, line } : row;
  });
  // Needs you first, then newest; ties keep the list order (sort is stable).
  cards.sort(
    (a, b) =>
      Number(b.state === "waiting") - Number(a.state === "waiting") || (b.at ?? 0) - (a.at ?? 0),
  );
  return { cards: cards.slice(0, HOME_CARDS), empty: rows.length === 0 };
}

/**
 * Where home stands with the computer.
 *
 * Three states, not two, because the gap between them is where the jumping
 * was. A socket that is merely re-dialling (every return to the app, for the
 * second or two the reconnect takes) used to read as "offline": Pew fell
 * asleep, "Can't reach your computer" appeared under him, and both went away
 * again a moment later, shifting him each time. The rest of the app calls that
 * state "Connecting…" and only gives up once `unreachable` says the retries
 * have stalled; home now draws the same line.
 */
export type HomeLink = "online" | "connecting" | "unreachable";

/** The daemon's connection fields, folded into a {@link HomeLink}. */
export function homeLink(status: string, unreachable: boolean | undefined): HomeLink {
  if (unreachable) return "unreachable";
  return status === "online" ? "online" : "connecting";
}

/** What home says when it has no cards to show (or can't reach the computer). */
export function homeMessage(p: {
  fatal?: string;
  link: HomeLink;
  agents?: number;
  empty: boolean;
  hasCards: boolean;
}): { title: string; line?: string } | undefined {
  if (p.fatal) return { title: "Can't connect", line: p.fatal };
  if (p.link === "unreachable")
    return {
      title: "Can't reach your computer",
      line: p.hasCards ? undefined : "It connects again by itself.",
    };
  // Re-dialling is not news when the cards are already up: they stay, Pew stays
  // awake, and nothing under him changes. With nothing to show yet it is the
  // one true thing to say.
  if (p.link === "connecting") return p.hasCards ? undefined : { title: "Connecting…" };
  if (p.agents === 0)
    return { title: "No agents turned on", line: "Run pew2 setup on your computer." };
  if (p.empty) return { title: "No sessions yet", line: "Start one from the menu." };
  return undefined;
}

/**
 * How many cards home lays itself out for, which is what places Pew.
 *
 * Never fewer than last launch showed. Every way the list can look short while
 * the app starts (not connected yet, connected but not answered, one agent's
 * list in and the rest still coming) is temporary, and laying out for it moved
 * Pew to the middle of the screen and back up a moment later. Fewer cards than
 * that just leave the space under them empty for this launch; the next one is
 * laid out for the new count (`parseHomeCards`). More cards than ever before is
 * the one change that can move him, and it is a real one.
 */
export function homeLayoutCards(p: {
  /** Cards known right now, already capped at {@link HOME_CARDS}. */
  known: number;
  /** The count home showed last time (`parseHomeCards`), if any. */
  remembered: number | undefined;
}): number {
  return Math.max(p.known, p.remembered ?? 0);
}

/**
 * How many cards home showed last time, as stored (a digit). Home lays itself
 * out for that many from the first frame, before the session list arrives,
 * so Pew never starts centred and then moves up. Unreadable reads as unknown.
 */
export function parseHomeCards(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || !/^[0-9]+$/.test(raw)) return undefined;
  return Math.min(HOME_CARDS, Number(raw));
}
