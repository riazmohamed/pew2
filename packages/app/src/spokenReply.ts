import MarkdownIt from "markdown-it";

/** Matches the live-turn buffer in `useDaemon`; anything past it is never read. */
export const SPOKEN_INPUT_LIMIT = 6000;
/** About ninety seconds of speech. Stop is always one tap away. */
export const SPOKEN_LIMIT = 1500;
const MORE = " More on screen.";
const markdown = new MarkdownIt({ html: false, linkify: false });

/**
 * The reply's prose, read out. The user is driving or walking and wants to
 * hear what the agent said, not a pointer to it: a first-sentence cue turned
 * out to be one word most of the time. Parse Markdown so fenced/indented code
 * and link targets stay silent; a long reply is cut at a sentence end and
 * says that the rest is on screen. `label` names the project only when the
 * reply is from a conversation other than the one being looked at.
 */
export function spokenReply(text: string | undefined, label?: string): string {
  const parts: string[] = [];
  for (const block of markdown.parse((text ?? "").slice(0, SPOKEN_INPUT_LIMIT), {})) {
    if (block.type !== "inline") continue;
    for (const token of block.children ?? []) {
      if (token.type === "text" || token.type === "code_inline") parts.push(token.content);
      if (token.type === "softbreak" || token.type === "hardbreak") parts.push(" ");
    }
    parts.push(" ");
  }
  const prose = parts.join("")
    .replace(/(?:\b[a-z][a-z\d+.-]*:\/\/|\bmailto:|\bwww\.)\S+/gi, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\s+/g, " ").trim();
  const who = label ? `${label}: ` : "";
  if (!prose) return `${who}response ready, on screen.`;
  const points = Array.from(prose);
  if (points.length <= SPOKEN_LIMIT) return who + prose;
  // Cut at the last sentence end inside the budget (a real character before
  // the stop, so "3.14" is not one), or at a word when the sentences run long.
  const head = points.slice(0, SPOKEN_LIMIT).join("");
  const sentence = /^[\s\S]*[^\d\s][.!?](?=\s)/.exec(head)?.[0];
  const cut = sentence && sentence.length >= head.length / 2
    ? sentence
    : head.replace(/\s+\S*$/, "") + "…";
  return `${who}${cut}${MORE}`;
}

export interface SpokenCompletion {
  /** `${sessionId}:${seq}` of the last live event, so a duplicate idle is silent. */
  id: string;
  sessionId: string;
  text: string;
  /** Project name, set only when the reply is not from the conversation on screen. */
  label?: string;
}

export interface ReadAloudDriver {
  stop(): Promise<void>;
  speak(text: string, done: () => void, error: () => void, current: () => boolean): Promise<void>;
}

/** Owns cancellation outside React so native/permission races can be tested. */
export class SpokenPlayback {
  enabled = false;
  speaking = false;
  capturing = false;
  private foreground = true;
  private latest: SpokenCompletion | undefined;
  private generation = 0;
  private stopping: Promise<boolean> = Promise.resolve(true);
  private disposed = false;

  constructor(
    private readonly driver: ReadAloudDriver,
    private readonly changed: () => void,
    private readonly report: (message: string) => void,
  ) {}

  get canReplay(): boolean {
    return this.enabled && this.foreground && !this.capturing && !!this.latest;
  }

  /** Any open conversation may cue; only leaving the screen silences and forgets. */
  context(foreground: boolean): void {
    if (this.foreground !== foreground) {
      this.latest = undefined;
      void this.stop();
    }
    this.foreground = foreground;
  }

  toggle(): void {
    this.enabled = !this.enabled;
    if (!this.enabled) void this.stop();
    this.changed();
  }

  complete(turn: SpokenCompletion): void {
    if (this.disposed || !this.foreground) return;
    if (this.latest?.id === turn.id) return;
    this.latest = turn;
    this.changed();
    if (this.enabled && !this.capturing) void this.play(turn);
  }

  replay(): void {
    if (this.canReplay && this.latest) void this.play(this.latest);
  }

  async microphone(): Promise<boolean> {
    this.capturing = true; // Block completions even while native stop is pending.
    this.changed();
    return await this.stop();
  }

  captureEnded(): void {
    this.capturing = false;
    this.changed();
  }

  async stop(): Promise<boolean> {
    ++this.generation;
    this.speaking = false;
    if (!this.disposed) this.changed();
    const previous = this.stopping;
    const stop = async (): Promise<boolean> => {
      await previous;
      try {
        await this.driver.stop();
        return true;
      } catch {
        if (!this.disposed) this.report("Could not stop speech. Try again before using the microphone.");
        return false;
      }
    };
    this.stopping = stop();
    return await this.stopping;
  }

  activate(): void {
    this.disposed = false;
  }

  dispose(): void {
    this.disposed = true;
    this.latest = undefined;
    void this.stop();
  }

  private async play(turn: SpokenCompletion): Promise<void> {
    const stopped = this.stop();
    const ticket = this.generation;
    if (!await stopped || ticket !== this.generation || !this.canReplay || this.disposed) return;
    this.speaking = true;
    this.changed();
    const finish = (failed: boolean): void => {
      if (ticket !== this.generation || this.disposed) return;
      this.speaking = false;
      this.changed();
      if (failed) this.report("Speech is unavailable or was interrupted. Read the response on screen.");
    };
    try {
      await this.driver.speak(
        spokenReply(turn.text, turn.label), () => finish(false), () => finish(true),
        () => ticket === this.generation && this.canReplay && !this.disposed,
      );
    } catch {
      finish(true);
    }
  }
}
