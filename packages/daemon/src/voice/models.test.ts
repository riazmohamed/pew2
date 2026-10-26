import { expect, test } from "bun:test";
import { fallbackModel, hitLimit, matchModel } from "./models.js";

const OG = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "gpt-6-astra",
  "gpt-6-astra-fast",
  "gpt-6.1-sol",
  "gpt-6.1-sol-fast",
  "gpt-6-luna",
  "gemini-3.1-pro-preview",
  "kimi-k3",
  "kimi-for-coding",
  "glm-5.3",
  "deepseek-v4-pro",
].map((value) => ({ value }));

const found = (said: string) => {
  const result = matchModel(said, OG);
  return result.kind === "found" ? result.model.value : result.kind;
};

test("a maker's name picks that maker's first plain model", () => {
  expect(found("GPT")).toBe("gpt-6-astra");
  expect(found("openai")).toBe("gpt-6-astra");
  expect(found("Claude")).toBe("claude-fable-5-1");
  expect(found("gemini")).toBe("gemini-3.1-pro-preview");
  expect(found("Kimi")).toBe("kimi-k3");
});

test("a spoken model name finds its id, the plain one over its fast twin", () => {
  expect(found("sonnet")).toBe("claude-sonnet-5-5");
  expect(found("opus")).toBe("claude-opus-5-5");
  expect(found("sol")).toBe("gpt-6.1-sol");
  expect(found("GPT six point one sol")).toBe("gpt-6.1-sol");
  expect(found("gpt-6-luna")).toBe("gpt-6-luna");
  expect(found("glm")).toBe("glm-5.3");
});

test("several different matches is a question; nothing is none", () => {
  expect(matchModel("5-5", OG).kind).toBe("ambiguous");
  expect(found("llama")).toBe("none");
  expect(found("")).toBe("none");
});

test("the fallback off Claude is the first plain GPT", () => {
  expect(fallbackModel(OG)?.value).toBe("gpt-6-astra");
  expect(fallbackModel([{ value: "opus" }, { value: "sonnet" }])).toBeUndefined();
});

test("a turn that stopped on a limit is spotted, an ordinary reply is not", () => {
  expect(hitLimit(["You've hit your session limit · resets 8:50pm (Asia/Riyadh)"])).toContain(
    "session limit",
  );
  expect(hitLimit(["API Error: 429 rate_limit_error"])).toBeDefined();
  expect(hitLimit(["Error: Overloaded"])).toBeDefined();
  expect(hitLimit(["Done. I fixed the tests.", "All 12 pass."])).toBeUndefined();
});

test("the briefing tells Pew which session hit a limit, and what to offer", async () => {
  const { buildInstructions } = await import("./session.js");
  const text = buildInstructions(
    [],
    [
      {
        sessionId: "s1",
        folder: "billing",
        agentName: "Claude Code",
        working: false,
        lastLines: [],
        limit: "You've hit your session limit · resets 8:50pm",
      },
    ],
    undefined,
    Date.now(),
  );
  expect(text).toContain(
    "billing (Claude Code): idle. HIT A USAGE LIMIT: You've hit your session limit · resets 8:50pm",
  );
  expect(text).toContain("Want me to switch it to GPT?");
  expect(text).toContain('agent "OG Coder", model "GPT"');
});
