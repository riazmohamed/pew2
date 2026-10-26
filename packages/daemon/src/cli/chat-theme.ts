/**
 * OG Coder's look, in plain ANSI, for `pew2 chat`.
 *
 * The colours are OG Coder's dark theme (`ggcoder/src/ui/theme/dark.json`) and
 * the shapes are its components: the gradient banner, the shaded user message,
 * the `⏺` assistant and tool prefix, the ruled `> ` input and the `│`-separated
 * footer. Pure strings in, strings out, so it stays testable without a TTY.
 */

export const THEME = {
  primary: "#60a5fa",
  secondary: "#a78bfa",
  success: "#4ade80",
  error: "#f87171",
  warning: "#fbbf24",
  text: "#e5e7eb",
  textDim: "#6b7280",
  textMuted: "#9ca3af",
  border: "#374151",
  accent: "#818cf8",
  toolName: "#60a5fa",
  inputPrompt: "#60a5fa",
  commandColor: "#818cf8",
  code: "#e2b553",
  link: "#60a5fa",
  diffAdded: "#4ade80",
  diffRemoved: "#f87171",
  userBackground: "#374151",
  maxThinking: "#db2777",
} as const;

export type ColorMode = "truecolor" | "256" | "none";

/** What the terminal can show. NO_COLOR wins; Apple Terminal tops out at 256. */
export function colorMode(env: Record<string, string | undefined>): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  const program = env.TERM_PROGRAM ?? "";
  if (program === "Apple_Terminal") return "256";
  if (["iTerm.app", "WezTerm", "vscode", "ghostty", "WarpTerminal"].includes(program))
    return "truecolor";
  if (env.LC_TERMINAL === "iTerm2") return "truecolor";
  return "256";
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Nearest xterm-256 index: the 6x6x6 cube or the grey ramp, whichever is closer. */
export function to256(hex: string): number {
  const [r, g, b] = rgb(hex);
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  const steps = [0, 95, 135, 175, 215, 255];
  const [cr, cg, cb] = [level(r), level(g), level(b)];
  const cube = 16 + 36 * cr + 6 * cg + cb;
  const cubeErr = (steps[cr]! - r) ** 2 + (steps[cg]! - g) ** 2 + (steps[cb]! - b) ** 2;
  const grey = Math.round((r + g + b) / 3);
  const gi = Math.max(0, Math.min(23, Math.round((grey - 8) / 10)));
  const gv = 8 + gi * 10;
  const greyErr = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return greyErr < cubeErr ? 232 + gi : cube;
}

export const RESET = "\x1b[0m";

export interface Paint {
  mode: ColorMode;
  fg: (hex: string, text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  italic: (text: string) => string;
  /** Foreground and background together, for the shaded user message. */
  fgBg: (fg: string, bg: string, text: string, bold?: boolean) => string;
  /** The bare escape, for text drawn in pieces. */
  fgCode: (hex: string) => string;
}

export function painter(mode: ColorMode): Paint {
  const code = (hex: string, layer: 38 | 48) => {
    if (mode === "none") return "";
    if (mode === "truecolor") return `\x1b[${layer};2;${rgb(hex).join(";")}m`;
    return `\x1b[${layer};5;${to256(hex)}m`;
  };
  const wrap = (open: string, text: string) => (open ? `${open}${text}${RESET}` : text);
  return {
    mode,
    fg: (hex, text) => wrap(code(hex, 38), text),
    bold: (text) => (mode === "none" ? text : `\x1b[1m${text}${RESET}`),
    dim: (text) => wrap(code(THEME.textDim, 38), text),
    italic: (text) => (mode === "none" ? text : `\x1b[3m${text}${RESET}`),
    fgBg: (fg, bg, text, bold = false) =>
      wrap(`${bold && mode !== "none" ? "\x1b[1m" : ""}${code(fg, 38)}${code(bg, 48)}`, text),
    fgCode: (hex) => code(hex, 38),
  };
}

/** Visible width once escapes (SGR and OSC) are removed. */
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function truncate(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return width <= 1 ? "…".slice(0, width) : `${chars.slice(0, width - 1).join("")}…`;
}

const LOGO = ["╭─────╮", "│ p·2 │", "╰─────╯"];
const GRADIENT_STEPS = 7;

function lerp(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${((1 << 24) | (mix(r1, r2) << 16) | (mix(g1, g2) << 8) | mix(b1, b2)).toString(16).slice(1)}`;
}

/** OG Coder's ping-pong primary → secondary ramp, one colour per glyph. */
function gradient(paint: Paint, text: string, offset: number): string {
  const oneWay = Array.from({ length: GRADIENT_STEPS }, (_, i) =>
    lerp(THEME.primary, THEME.secondary, i / (GRADIENT_STEPS - 1)),
  );
  const ramp = [...oneWay, ...oneWay.slice(1, -1).reverse()];
  let index = offset;
  let out = "";
  for (const ch of text) {
    if (ch === " ") {
      out += ch;
      continue;
    }
    out += paint.fg(ramp[index % ramp.length]!, ch);
    index++;
  }
  return out;
}

export interface BannerInfo {
  version: string;
  /** Project name, or "all projects". */
  project: string;
  /** Agent and model, as known at startup. */
  agent: string;
  model?: string;
  /** Working directory to show, already `~`-shortened. */
  path?: string;
}

/** The startup banner: logo beside a name line, a model line and key hints. */
export function bannerLines(info: BannerInfo, paint: Paint, columns: number): string[] {
  const name = `${paint.bold(paint.fg(THEME.primary, "pew2"))}${paint.dim(" · ")}${paint.bold(paint.fg(THEME.text, info.project))}${paint.dim(` v${info.version}`)}`;
  const model = `${paint.fg(THEME.secondary, info.model ? `${info.agent} · ${info.model}` : info.agent)}${info.path ? paint.dim(`  ${info.path}`) : ""}`;
  const key = (k: string, what: string) => `${paint.fg(THEME.primary, k)}${paint.dim(` ${what}`)}`;
  const hints = [
    key("/model", "switch model"),
    key("/shot", "screenshot"),
    key("Tab", "complete"),
    key("/help", "commands"),
  ].join(paint.dim(" · "));
  const info3 = [name, model, hints];
  const logo = LOGO.map((line, i) => gradient(paint, line, i * 2));
  if (columns < 70) return ["", ...logo, ...info3, ""];
  return ["", ...logo.map((line, i) => `${line}   ${info3[i]}`), ""];
}

/** A user turn: a shaded block with OG Coder's `> ` prefix. */
export function userMessageLines(
  text: string,
  paint: Paint,
  columns: number,
  imageCount = 0,
): string[] {
  const width = Math.max(10, columns - 1);
  const bg = THEME.userBackground;
  const inner = width - 4;
  const media = Array.from({ length: imageCount }, (_, i) => `[Image #${i + 1}]`).join(" ");
  const body = media ? `${text}${text ? " " : ""}${media}` : text;
  const rows: string[] = [];
  for (const line of body.split("\n")) {
    const chars = [...line];
    if (chars.length === 0) rows.push("");
    for (let i = 0; i < chars.length; i += inner) rows.push(chars.slice(i, i + inner).join(""));
  }
  if (paint.mode === "none") return rows.map((row, i) => `${i === 0 ? "> " : "  "}${row}`);
  const out = [paint.fg(bg, "▄".repeat(width))];
  rows.forEach((row, i) => {
    const pad = " ".repeat(Math.max(0, inner - [...row].length));
    out.push(
      `${paint.fgBg(THEME.commandColor, bg, ` ${i === 0 ? "> " : "  "}`, true)}${paint.fgBg(THEME.commandColor, bg, `${row}${pad} `)}`,
    );
  });
  out.push(paint.fg(bg, "▀".repeat(width)));
  return out;
}

export const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

/** OG Coder's compact tool line: a dot, the tool's name in bold, the detail dim. */
export function toolLine(title: string, paint: Paint, columns: number, status?: string): string {
  const color =
    status === "failed" ? THEME.error : status === "completed" ? THEME.success : THEME.toolName;
  const room = Math.max(10, columns - 4);
  const text = truncate(title.replace(/\s+/g, " ").trim() || "tool", room);
  const cut = text.search(/[\s(]/);
  const label = cut > 0 ? text.slice(0, cut) : text;
  const rest = cut > 0 ? text.slice(cut) : "";
  return ` ${paint.fg(color, BLACK_CIRCLE)} ${paint.bold(paint.fg(THEME.toolName, label))}${rest ? paint.fg(THEME.textMuted, rest) : ""}`;
}

/** The `⎿` gutter under a tool line. */
export function toolResultLine(text: string, paint: Paint, color: string = THEME.textDim): string {
  return `   ${paint.dim("⎿")}  ${paint.fg(color, text)}`;
}

export interface DiffView {
  path: string;
  added: string[];
  removed: string[];
}

/** A compact diff under a tool line: counts, then a few changed lines. */
export function diffLines(diff: DiffView, paint: Paint, columns: number, max = 8): string[] {
  const name = diff.path.split(/[\\/]/).pop() ?? diff.path;
  const out = [
    toolResultLine(
      `${name} ${paint.fg(THEME.diffAdded, `+${diff.added.length}`)} ${paint.fg(THEME.diffRemoved, `-${diff.removed.length}`)}`,
      paint,
      THEME.textMuted,
    ),
  ];
  const room = Math.max(10, columns - 10);
  const shown = [
    ...diff.removed.map((line) => paint.fg(THEME.diffRemoved, `- ${truncate(line, room)}`)),
    ...diff.added.map((line) => paint.fg(THEME.diffAdded, `+ ${truncate(line, room)}`)),
  ];
  for (const line of shown.slice(0, max)) out.push(`      ${line}`);
  if (shown.length > max) out.push(`      ${paint.dim(`… ${shown.length - max} more`)}`);
  return out;
}

/** The input box rule, in OG Coder's border colour. */
export function ruleLine(paint: Paint, columns: number): string {
  return paint.fg(THEME.border, "─".repeat(Math.max(1, columns - 1)));
}

/** The prompt line: `> ` then the text, a leading slash command in the command colour. */
export function promptLine(input: string, paint: Paint): string {
  const shown = input.replace(/\n/g, "↵");
  const match = /^\/[\w:-]*/.exec(shown);
  const body = match
    ? `${paint.bold(paint.fg(THEME.commandColor, match[0]))}${paint.fg(THEME.text, shown.slice(match[0].length))}`
    : paint.fg(THEME.text, shown);
  return `${paint.bold(paint.fg(THEME.inputPrompt, ">"))} ${body}`;
}

/** Slash menu under the input while a command name is being typed. */
export function slashMenuLines(
  matches: readonly { name: string; description: string; agent?: boolean }[],
  paint: Paint,
  columns: number,
  max = 5,
): string[] {
  const nameWidth = Math.min(24, Math.max(...matches.map((m) => m.name.length + 1), 4));
  const lines = matches.slice(0, max).map((m) => {
    const label = `/${m.name}`.padEnd(nameWidth + 1);
    const room = Math.max(0, columns - 4 - label.length);
    return `  ${paint.fg(m.agent ? THEME.secondary : THEME.commandColor, label)} ${paint.dim(truncate(m.description, room))}`;
  });
  if (matches.length > max)
    lines.push(`  ${paint.dim(`… ${matches.length - max} more, keep typing`)}`);
  return lines;
}

export interface FooterView {
  /** Project or cwd folder name. */
  path?: string;
  /** What Enter goes to. */
  status: string;
  model?: string;
  thinking?: string;
  mode?: string;
  keys: string;
}

function thinkingColor(level: string | undefined): string {
  if (!level) return THEME.textDim;
  const l = level.toLowerCase();
  if (l === "none" || l === "off") return THEME.textDim;
  if (l.includes("max") || l.includes("xhigh") || l.includes("ultra")) return THEME.maxThinking;
  if (l.includes("high") || l.includes("hard")) return THEME.warning;
  if (l.includes("low") || l.includes("minimal")) return THEME.textMuted;
  return THEME.accent;
}

/**
 * OG Coder's footer: path and status on the left, model and thinking on the
 * right, `│` between. pew2's keys go on the same row when it fits, below when
 * not.
 */
export function footerLines(view: FooterView, paint: Paint, columns: number): string[] {
  const width = Math.max(20, columns - 1);
  const sep = paint.fg(THEME.border, " │ ");
  const leftParts = [view.path, view.status].filter((p): p is string => !!p);
  const rightParts: string[] = [];
  const rightPlain: string[] = [];
  if (view.model) {
    rightParts.push(paint.bold(paint.fg(THEME.primary, view.model)));
    rightPlain.push(view.model);
  }
  if (view.mode) {
    rightParts.push(paint.fg(THEME.secondary, view.mode));
    rightPlain.push(view.mode);
  }
  if (view.thinking) {
    const text = `Thinking ${view.thinking}`;
    rightParts.push(paint.fg(thinkingColor(view.thinking), text));
    rightPlain.push(text);
  }
  const rightLen = rightPlain.join(" │ ").length;
  const room = width - 1 - rightLen - (rightLen ? 2 : 0);
  let leftPlain = leftParts.join(" │ ");
  if ([...leftPlain].length > room) leftPlain = truncate(leftPlain, Math.max(1, room));
  const left = leftPlain
    .split(" │ ")
    .map((part, i) =>
      i === 0 && leftParts.length > 1 ? paint.dim(part) : paint.fg(THEME.textMuted, part),
    )
    .join(sep);
  const gap = " ".repeat(Math.max(1, width - 1 - [...leftPlain].length - rightLen));
  const first = ` ${left}${rightLen ? `${gap}${rightParts.join(sep)}` : ""}`;
  return [first, ` ${paint.dim(truncate(view.keys, width - 1))}`];
}
