import { expect, test } from "bun:test";
import { wire } from "@pew2/protocol";
import { applyInput, renderEvents, simpleDiff } from "./chat-core.js";
import { MarkdownStream, markdownImages, renderMarkdown } from "./chat-markdown.js";
import {
  bannerLines,
  colorMode,
  footerLines,
  painter,
  stripAnsi,
  to256,
  toolLine,
  userMessageLines,
} from "./chat-theme.js";
import {
  completeSlash,
  currentLabel,
  findOption,
  helpLines,
  listOption,
  pickOptionValue,
  readAgentCommands,
  routeSlash,
  slashMatches,
  type ConfigOptionLike,
} from "./chat-commands.js";
import {
  attachmentsError,
  buildAttachment,
  imageMimeForPath,
  imagesFromAttachments,
  imagesFromContent,
  needsDownscale,
  osc1337,
  parseAttachArgs,
  parseDataUri,
  screenshotName,
  supportsInlineImages,
} from "./chat-images.js";

const plain = painter("none");
const color = painter("truecolor");

test("markdown loses its markers and keeps its meaning", () => {
  const lines = renderMarkdown(
    [
      "# Title",
      "Some **bold** and `code` and *it* and snake_case_name.",
      "- one",
      "1. first",
      "> quoted",
      "```ts",
      "const a = 1;",
      "```",
      "[docs](https://x.y)",
    ].join("\n"),
    plain,
  );
  expect(lines).toEqual([
    "Title",
    "Some bold and code and it and snake_case_name.",
    "• one",
    "1. first",
    "│ quoted",
    "ts",
    "  const a = 1;",
    "docs (https://x.y)",
  ]);
  const bold = renderMarkdown("a **b** c", color)[0]!;
  expect(bold).toContain("\x1b[1mb");
  expect(bold).not.toContain("**");
  expect(renderMarkdown("`x`", color)[0]).toContain("38;2;226;181;83");
});

test("a streamed reply draws whole lines, previews the tail, and prefixes like OG Coder", () => {
  const stream = new MarkdownStream(plain);
  expect(stream.feed("Hello **wor")).toEqual([]);
  expect(stream.preview().slice(2)).toBe("Hello **wor");
  const outs = stream.feed("ld**\n\n\nnext ![shot](/tmp/a.png)\n");
  const texts = outs
    .filter((o) => o.kind === "line")
    .map((o) => (o.kind === "line" ? o.text.slice(2) : ""));
  expect(texts).toEqual(["Hello world", "", "next [image: shot]"]);
  expect(outs.some((o) => o.kind === "image" && o.src === "/tmp/a.png")).toBe(true);
  expect(stream.feed("tail")).toEqual([]);
  expect(stream.flush()).toEqual([{ kind: "line", text: "  tail" }]);
  expect(markdownImages("![](notes.md) ![x](data:image/png;base64,AA)")).toEqual([
    { src: "data:image/png;base64,AA", alt: "x" },
  ]);
});

test("colours: truecolor, 256 fallback, NO_COLOR", () => {
  expect(colorMode({ COLORTERM: "truecolor" })).toBe("truecolor");
  expect(colorMode({ TERM_PROGRAM: "Apple_Terminal" })).toBe("256");
  expect(colorMode({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
  expect(to256("#000000")).toBe(16);
  expect(to256("#ffffff")).toBe(231);
  expect(painter("256").fg("#60a5fa", "x")).toMatch(/^\x1b\[38;5;\d+mx\x1b\[0m$/);
  expect(plain.fg("#60a5fa", "x")).toBe("x");
});

test("banner, user message, tool line and footer read like OG Coder", () => {
  const banner = bannerLines(
    { version: "1.2.3", project: "pew2", agent: "Echo (test)", model: "Echo Pro", path: "~/p" },
    plain,
    100,
  ).map(stripAnsi);
  expect(banner[1]).toContain("pew2 · pew2 v1.2.3");
  expect(banner[2]).toContain("Echo (test) · Echo Pro  ~/p");
  expect(banner[3]).toContain("/model switch model");
  expect(userMessageLines("hi", plain, 40)).toEqual(["> hi"]);
  const shaded = userMessageLines("hi", color, 40, 1);
  expect(shaded[0]).toContain("▄");
  expect(stripAnsi(shaded[1]!)).toStartWith(" > hi [Image #1]");
  expect(stripAnsi(toolLine("Read src/a.ts", plain, 80)).slice(2)).toBe(" Read src/a.ts");
  const footer = footerLines(
    { status: "→ Echo · pew2", model: "Echo Pro", thinking: "Think", keys: "Esc quit" },
    plain,
    80,
  );
  expect(footer[0]).toStartWith(" → Echo · pew2");
  expect(footer[0]).toEndWith("Echo Pro │ Thinking Think");
  expect(footer[1]).toBe(" Esc quit");
});

const options: ConfigOptionLike[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "echo-pro",
    options: [
      { value: "echo-mini", name: "Echo Mini" },
      { value: "echo-pro", name: "Echo Pro" },
      { value: "echo-max", name: "Echo Max" },
    ],
  },
  { id: "fast", name: "Fast", category: "mode", type: "boolean", currentValue: false },
];

test("config options list, mark the current one, and pick by number, name or prefix", () => {
  const model = findOption(options, "model")!;
  expect(currentLabel(model)).toBe("Echo Pro");
  const listed = listOption(model, "model", "Echo");
  expect(listed[2]).toBe("● 2. Echo Pro  (echo-pro)  current");
  expect(listed[1]).toBe("  1. Echo Mini  (echo-mini)");
  expect(listOption(findOption(options, "thought_level"), "thought_level", "Echo")).toEqual([
    "Echo offers no thinking level choice here.",
  ]);
  expect(pickOptionValue(model, "3")).toEqual({ value: "echo-max", name: "Echo Max" });
  expect(pickOptionValue(model, "echo mini")).toEqual({ value: "echo-mini", name: "Echo Mini" });
  expect(pickOptionValue(model, "max")).toEqual({ value: "echo-max", name: "Echo Max" });
  expect(pickOptionValue(model, "echo")).toHaveProperty("error");
  expect(pickOptionValue(model, "9")).toEqual({ error: "choose 1-3" });
  expect(pickOptionValue(findOption(options, "mode")!, "on")).toEqual({ value: true, name: "on" });
});

test("slash commands route local first, then the agent's as a prompt, else unknown", () => {
  const agent = readAgentCommands({
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "compact", description: "Compact" },
        { name: "model", description: "Agent picker" },
        { name: "review", description: "Review", input: { hint: "pr" } },
      ],
    },
  })!;
  expect(agent.map((c) => c.name)).toEqual(["compact", "model", "review"]);
  expect(readAgentCommands({ update: { sessionUpdate: "plan" } })).toBeUndefined();
  expect(routeSlash("/model 2", agent)).toEqual({ kind: "local", name: "model", arg: "2" });
  expect(routeSlash("/compact keep tests", agent)).toEqual({
    kind: "agent",
    name: "compact",
    text: "/compact keep tests",
  });
  expect(routeSlash("/nope", agent)).toEqual({ kind: "unknown", name: "nope" });
  const help = helpLines(agent, "Echo").join("\n");
  expect(help).toContain("/compact");
  expect(help).toContain("/review pr");
  expect(help).toContain("pew2's own wins here: /model");
  expect(helpLines([], "Echo").at(-1)).toBe("Echo has not listed any commands of its own yet.");
  expect(slashMatches("/c", agent).map((m) => m.name)).toEqual(["cancel", "compact"]);
});

test("Tab completes a slash command", () => {
  const names = ["help", "model", "mode", "shot", "compact"];
  expect(completeSlash("/sh", names)).toEqual({ input: "/shot ", candidates: [] });
  expect(completeSlash("/mo", names)).toEqual({ input: "/mode", candidates: ["mode", "model"] });
  expect(completeSlash("/zz", names)).toEqual({ input: "/zz", candidates: [] });
  expect(completeSlash("hello", names)).toEqual({ input: "hello", candidates: [] });
  expect(applyInput("/sh", "\t").actions).toEqual([{ kind: "tab" }]);
  expect(applyInput("", "\x1b[200~a\tb\x1b[201~").buffer).toBe("a b");
});

test("images are found in agent blocks, links, tool output and the user's attachments", () => {
  expect(imagesFromContent({ type: "image", mimeType: "image/png", data: "AAA" })).toEqual([
    { src: "data:image/png;base64,AAA", name: "image" },
  ]);
  expect(
    imagesFromContent([
      { type: "resource_link", uri: "/x/plot.png", name: "plot.png" },
      { type: "resource_link", uri: "/x/a.md" },
    ]),
  ).toEqual([{ src: "/x/plot.png", name: "plot.png" }]);
  expect(
    imagesFromAttachments([
      { name: "shot.png", mimeType: "image/png", uri: "/tmp/pew2-attachments/s/0-shot.png" },
    ]),
  ).toHaveLength(1);
  const user = renderEvents({
    kind: "user_message",
    text: "look",
    attachments: [{ name: "a.png", mimeType: "image/png", uri: "/t/a.png" }],
  });
  expect(user).toEqual([
    { kind: "user", text: "look", images: 1 },
    { kind: "image", image: { src: "/t/a.png", name: "a.png" } },
  ]);
  const tool = renderEvents({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "diff", path: "/a/b.ts", oldText: "x\ny", newText: "x\nz" }],
    },
  });
  expect(tool).toEqual([
    { kind: "toolResult", id: "t1", diff: { path: "/a/b.ts", added: ["z"], removed: ["y"] } },
  ]);
  expect(simpleDiff("f", undefined, "a")).toEqual({ path: "f", added: ["a"], removed: [] });
});

test("iTerm2 inline images: detection and OSC 1337", () => {
  expect(supportsInlineImages({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
  expect(supportsInlineImages({ LC_TERMINAL: "iTerm2" })).toBe(true);
  expect(supportsInlineImages({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
  const base64 = Buffer.from("PNGDATA").toString("base64");
  expect(osc1337(base64, "a.png", 100)).toBe(
    `\x1b]1337;File=name=${Buffer.from("a.png").toString("base64")};size=7;width=60;preserveAspectRatio=1;inline=1:${base64}\x07`,
  );
  expect(parseDataUri("data:image/jpeg;base64,QUJD")).toEqual({
    mimeType: "image/jpeg",
    base64: "QUJD",
  });
  expect(parseDataUri("nope")).toBeUndefined();
});

test("attachments: dropped paths, mime types and the wire limits", () => {
  expect(parseAttachArgs("/Users/me/My\\ Shot.png what is this", "/Users/me")).toEqual({
    path: "/Users/me/My Shot.png",
    message: "what is this",
  });
  expect(parseAttachArgs("'/a b/c.png'")).toEqual({ path: "/a b/c.png", message: "" });
  expect(parseAttachArgs("file:///a%20b.png")?.path).toBe("/a b.png");
  expect(parseAttachArgs("~/x.png", "/h")?.path).toBe("/h/x.png");
  expect(imageMimeForPath("x.JPG")).toBe("image/jpeg");
  expect(imageMimeForPath("x.txt")).toBeUndefined();
  const ok = buildAttachment("a.png", "image/png", new Uint8Array([1, 2, 3]));
  expect(ok).toEqual({ attachment: { name: "a.png", mimeType: "image/png", data: "AQID" } });
  expect(
    buildAttachment("big.png", "image/png", new Uint8Array(wire.MAX_ATTACHMENT_BYTES + 1)),
  ).toHaveProperty("error");
  expect(buildAttachment("e.png", "image/png", new Uint8Array())).toEqual({
    error: "'e.png' is empty",
  });
  const one = { name: "a", mimeType: "image/png", data: "AQID" };
  expect(attachmentsError([one])).toBeUndefined();
  expect(attachmentsError(Array.from({ length: wire.MAX_ATTACHMENTS + 1 }, () => one))).toContain(
    "too many",
  );
  expect(needsDownscale(1000, 3024)).toBe(true);
  expect(needsDownscale(1000, 1200)).toBe(false);
  expect(screenshotName(new Date(2026, 9, 13, 9, 5, 7))).toBe("screenshot-20261013-090507.png");
});
