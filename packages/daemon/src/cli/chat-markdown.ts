/**
 * Assistant markdown, drawn the basic way OG Coder draws it: bold, italics,
 * inline code, fenced code blocks, headings, bullets, blockquotes and links,
 * with the markers themselves gone. Line by line, because replies stream: a
 * line is rendered once it is complete, and the unfinished tail is previewed.
 */
import { BLACK_CIRCLE, THEME, type Paint } from "./chat-theme.js";

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;

/** A source worth drawing as a picture: an image data URI or an image file name. */
export function isImageSource(src: string): boolean {
  const value = src.trim();
  if (!value) return false;
  if (/^data:image\/svg/i.test(value)) return false;
  if (value.startsWith("data:")) return value.startsWith("data:image/");
  return IMAGE_EXTENSION.test(value.split("?")[0]!.split("#")[0]!);
}

/** `![alt](src)` images in one line of markdown, displayable ones only. */
export function markdownImages(line: string): { src: string; alt: string }[] {
  const out: { src: string; alt: string }[] = [];
  for (const match of line.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const src = match[2]!;
    if (isImageSource(src)) out.push({ src, alt: match[1] || src.split(/[\\/]/).pop() || "image" });
  }
  return out;
}

/** Inline spans: code, images, links, bold, italics. */
export function renderInline(text: string, paint: Paint): string {
  let out = "";
  let rest = text;
  let prev = " ";
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^`([^`]+)`/, (m) => paint.fg(THEME.code, m[1]!)],
    [/^!\[([^\]]*)\]\(([^)]*)\)/, (m) => paint.dim(`[image: ${m[1] || m[2]!.split(/[\\/]/).pop()}]`)],
    [/^\[([^\]]+)\]\(([^)]*)\)/, (m) => `${paint.fg(THEME.link, m[1]!)}${m[2] && m[2] !== m[1] ? paint.dim(` (${m[2]})`) : ""}`],
    [/^\*\*\*([^*]+)\*\*\*/, (m) => paint.bold(paint.italic(m[1]!))],
    [/^\*\*([^*]+?)\*\*/, (m) => paint.bold(m[1]!)],
    [/^__([^_]+?)__/, (m) => paint.bold(m[1]!)],
    [/^~~([^~]+?)~~/, (m) => (paint.mode === "none" ? m[1]! : `\x1b[9m${m[1]}\x1b[0m`)],
    [/^\*([^*\s][^*]*?)\*/, (m) => paint.italic(m[1]!)],
    [/^_([^_\s][^_]*?)_(?![A-Za-z0-9])/, (m) => paint.italic(m[1]!)],
  ];
  outer: while (rest.length > 0) {
    // `_` inside a word (snake_case) is not emphasis.
    for (const [pattern, draw] of rules) {
      if (pattern.source.startsWith("^_") && /[A-Za-z0-9]/.test(prev)) continue;
      const match = pattern.exec(rest);
      if (match) {
        out += draw(match);
        prev = match[0][match[0].length - 1]!;
        rest = rest.slice(match[0].length);
        continue outer;
      }
    }
    prev = rest[0]!;
    out += prev;
    rest = rest.slice(1);
  }
  return out;
}

export interface MarkdownState {
  /** Inside a fenced code block, with the fence that opened it. */
  fence?: string;
}

/**
 * One complete markdown line, or undefined for a line that draws nothing (a
 * closing fence).
 */
export function renderMarkdownLine(line: string, state: MarkdownState, paint: Paint, columns = 80): string | undefined {
  const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
  if (state.fence) {
    if (fence && fence[1]!.startsWith(state.fence[0]!) && fence[1]!.length >= state.fence.length && !fence[2]) {
      state.fence = undefined;
      return undefined;
    }
    return `  ${paint.fg(THEME.code, line)}`;
  }
  if (fence) {
    state.fence = fence[1];
    return fence[2] ? paint.fg("#2dd4bf", fence[2]) : undefined;
  }
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    const body = renderInline(heading[2]!.replace(/\s+#+\s*$/, ""), paint);
    return heading[1]!.length <= 2 ? paint.bold(paint.fg(THEME.primary, body)) : paint.bold(body);
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return paint.fg(THEME.border, "─".repeat(Math.max(3, Math.min(40, columns - 4))));
  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) return `${paint.fg(THEME.border, "│")} ${paint.italic(paint.fg(THEME.textMuted, renderInline(quote[1]!, paint)))}`;
  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  if (task) {
    const done = task[2] !== " ";
    return `${task[1]}${paint.fg(done ? THEME.success : THEME.textDim, done ? "☑" : "☐")} ${renderInline(task[3]!, paint)}`;
  }
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}${paint.fg(THEME.accent, "•")} ${renderInline(bullet[2]!, paint)}`;
  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (numbered) return `${numbered[1]}${paint.fg(THEME.accent, `${numbered[2]}.`)} ${renderInline(numbered[3]!, paint)}`;
  return renderInline(line, paint);
}

/** Whole markdown text to ANSI lines, for tests and replays. */
export function renderMarkdown(text: string, paint: Paint, columns = 80): string[] {
  const state: MarkdownState = {};
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const drawn = renderMarkdownLine(line, state, paint, columns);
    if (drawn !== undefined) out.push(drawn);
  }
  return out;
}

export type MarkdownOut = { kind: "line"; text: string } | { kind: "image"; src: string; alt: string };

/**
 * One assistant reply as it streams. Feed it chunks; it hands back finished
 * lines, prefixed like OG Coder's (`⏺ ` on the first, two spaces after), plus
 * any images those lines named.
 */
export class MarkdownStream {
  private buffer = "";
  private state: MarkdownState = {};
  private started = false;
  private blankRun = 0;

  constructor(
    private readonly paint: Paint,
    private readonly columns: () => number = () => 80,
  ) {}

  private prefix(): string {
    if (this.started) return "  ";
    this.started = true;
    return `${this.paint.fg(THEME.primary, BLACK_CIRCLE)} `;
  }

  private line(raw: string): MarkdownOut[] {
    if (raw.trim() === "" && !this.state.fence) {
      // No leading blank lines, and runs of them fold to one.
      if (!this.started || this.blankRun > 0) return [];
      this.blankRun++;
      return [{ kind: "line", text: "" }];
    }
    this.blankRun = 0;
    const drawn = renderMarkdownLine(raw, this.state, this.paint, this.columns());
    const out: MarkdownOut[] = drawn === undefined ? [] : [{ kind: "line", text: `${this.prefix()}${drawn}` }];
    if (!this.state.fence) for (const image of markdownImages(raw)) out.push({ kind: "image", ...image });
    return out;
  }

  feed(text: string): MarkdownOut[] {
    this.buffer += text;
    const out: MarkdownOut[] = [];
    let cut = this.buffer.indexOf("\n");
    while (cut >= 0) {
      out.push(...this.line(this.buffer.slice(0, cut).replace(/\r$/, "")));
      this.buffer = this.buffer.slice(cut + 1);
      cut = this.buffer.indexOf("\n");
    }
    return out;
  }

  /** The unfinished line as it would draw now, without consuming it. */
  preview(): string {
    if (!this.buffer) return "";
    const prefix = this.started ? "  " : `${this.paint.fg(THEME.primary, BLACK_CIRCLE)} `;
    const drawn = renderMarkdownLine(this.buffer, { ...this.state }, this.paint, this.columns());
    return `${prefix}${drawn ?? ""}`;
  }

  /** End of the reply: the unfinished line, drawn. */
  flush(): MarkdownOut[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest ? this.line(rest) : [];
  }
}
