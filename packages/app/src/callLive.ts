/**
 * The call screen's "live" panel: what the coding agent is streaming back on
 * the chat the call is working with. Pure: which session, its last prompt,
 * its latest reply, and whether it is still working.
 */
import type { Session, Turn } from "./daemonTypes";
import type { BoardSession } from "./voiceBoard";
import type { CallState } from "./voiceCall";

/** Longest reply tail the panel keeps: the end is what is new. */
export const LIVE_MAX_CHARS = 4000;
/** Longest prompt line. */
export const LIVE_PROMPT_CHARS = 140;

export interface CallLive {
  sessionId: string;
  /** Folder name for the pill, when known. */
  project?: string;
  /** The latest prompt sent to the chat, one line. */
  prompt?: string;
  /** The agent's latest reply (tail-trimmed), or the board's lines when the chat was never opened here. */
  text: string;
  /** True when `text` came from the board lane rather than the transcript. */
  fromBoard: boolean;
  working: boolean;
}

/**
 * The session to show: the spotlit lane, else the session of the item the
 * call was placed from (`focus`: the inbox knows; the id's prefix otherwise).
 */
export function liveSessionId(spotlight: string | undefined, call: { focus?: string; inbox?: CallState["inbox"] }): string | undefined {
  if (spotlight) return spotlight;
  if (!call.focus) return undefined;
  return call.inbox?.find((item) => item.id === call.focus)?.sessionId ?? call.focus.split(":")[0];
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function tail(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(t.length - max + 1)}` : t;
}

/** The last user turn and the agent text after it (all agent turns since that prompt, joined). */
export function lastExchange(turns: readonly Turn[]): { prompt?: string; reply: string } {
  let i = turns.length - 1;
  while (i >= 0 && turns[i]?.role !== "user") i--;
  const prompt = i >= 0 ? turns[i]?.text : undefined;
  const parts: string[] = [];
  for (let k = i + 1; k < turns.length; k++) {
    const turn = turns[k];
    if (turn?.role === "agent" && turn.text.trim()) parts.push(turn.text.trim());
  }
  return { ...(prompt?.trim() ? { prompt: oneLine(prompt, LIVE_PROMPT_CHARS) } : {}), reply: tail(parts.join("\n\n"), LIVE_MAX_CHARS) };
}

function baseName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1];
}

/**
 * The panel's content for one session, or undefined when there is nothing to
 * show (no id, or neither a transcript nor a board lane for it).
 */
export function callLive(
  sessionId: string | undefined,
  sessions: readonly Pick<Session, "id" | "turns" | "busy" | "folder" | "cwd">[] | undefined,
  boardSessions: readonly Pick<BoardSession, "sessionId" | "folder" | "status" | "lines">[],
): CallLive | undefined {
  if (!sessionId) return undefined;
  const session = sessions?.find((s) => s.id === sessionId);
  const lane = boardSessions.find((s) => s.sessionId === sessionId);
  if (!session && !lane) return undefined;
  const project = lane?.folder ?? session?.folder ?? baseName(session?.cwd);
  const working = session?.busy === true || lane?.status === "working";
  const exchange = lastExchange(session?.turns ?? []);
  if (exchange.reply || exchange.prompt) {
    return { sessionId, ...(project ? { project } : {}), ...(exchange.prompt ? { prompt: exchange.prompt } : {}), text: exchange.reply, fromBoard: false, working };
  }
  const lines = (lane?.lines ?? []).filter((l) => l.kind !== "pew").map((l) => l.text.trim()).filter(Boolean);
  return { sessionId, ...(project ? { project } : {}), text: tail(lines.join("\n"), LIVE_MAX_CHARS), fromBoard: true, working };
}
