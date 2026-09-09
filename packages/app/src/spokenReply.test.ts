import { describe, expect, test } from "bun:test";
import { CUE_LIMIT, SpokenPlayback, spokenCue, type ReadAloudDriver } from "./spokenReply";

const turn = { id: "one:2", sessionId: "one", text: "The tests failed. Do not deploy.", label: "Codex, pew2" };

function fixture(stop: () => Promise<void> = async () => {}) {
  const spoken: string[] = [];
  const callbacks: Array<{ done: () => void; error: () => void; current: () => boolean }> = [];
  const errors: string[] = [];
  const driver: ReadAloudDriver = {
    stop,
    async speak(text, done, error, current): Promise<void> {
      spoken.push(text);
      callbacks.push({ done, error, current });
    },
  };
  const playback = new SpokenPlayback(driver, () => {}, (message) => errors.push(message));
  playback.context(true);
  return { playback, spoken, callbacks, errors };
}

// Drain the finite native promise chain without wall-clock timing.
async function settled(): Promise<void> {
  for (let i = 0; i < 20; ++i) await Promise.resolve();
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("spoken cue", () => {
  for (const text of [undefined, "", "```ts\nthrow new Error('secret code');\n```", "~~~\ncode\n~~~", "    indented code", "```\nunclosed code"]) {
    test(`honest fallback for ${JSON.stringify(text)}`, () => {
      expect(spokenCue(text, "Codex, pew2")).toBe("Codex, pew2: response ready. On screen.");
      expect(spokenCue(text)).toBe("response ready. On screen.");
    });
  }
  test("first sentence only, named, without decoration or destinations", () => {
    const result = spokenCue("## **Step 1 done**, tests pass. See [details](https://private.example/token).\n```sh\nrm dangerous\n```\nMore prose.", "Codex, pew2");
    expect(result).toBe("Codex, pew2: Step 1 done, tests pass. On screen.");
  });
  test("a number with a decimal point is not a sentence end", () => {
    expect(spokenCue("Coverage is 3.14 percent now. Next step.")).toBe("Coverage is 3.14 percent now. On screen.");
  });
  test("a long first sentence is cut at a word, in Unicode characters", () => {
    const result = spokenCue("🙂 café 未確認 ".repeat(100));
    expect(Array.from(result).length).toBeLessThanOrEqual(CUE_LIMIT + " On screen.".length + 1);
    expect(result.endsWith("… On screen.")).toBe(true);
    expect(result).not.toContain("�");
  });
  test("images, reference destinations and autolinks are not spoken", () => {
    const result = spokenCue("![private image](https://secret/image)\nRead [report][r] <https://secret/link>\n\n[r]: https://secret/reference");
    expect(result).toBe("Read report On screen.");
  });
});

describe("playback lifecycle", () => {
  test("off by default; enabling does not automatically read old text", async () => {
    const { playback, spoken } = fixture();
    playback.complete(turn);
    playback.toggle();
    await settled();
    expect(spoken).toEqual([]);
    playback.replay();
    await settled();
    expect(spoken).toEqual([spokenCue(turn.text, turn.label)]);
  });
  test("any conversation cues while on screen; background and duplicates are silent", async () => {
    const { playback, spoken } = fixture();
    playback.toggle();
    playback.context(false);
    playback.complete(turn);
    playback.context(true);
    await settled();
    expect(spoken).toEqual([]);
    playback.complete({ ...turn, sessionId: "other", id: "other:1", label: "Claude, brah" });
    await settled();
    playback.complete({ ...turn, sessionId: "other", id: "other:1", label: "Claude, brah" });
    await settled();
    expect(spoken).toEqual(["Claude, brah: The tests failed. On screen."]);
  });
  test("dictation blocks automatic and manual playback, without deferred audio", async () => {
    const { playback, spoken } = fixture();
    playback.toggle();
    await playback.microphone();
    playback.complete(turn);
    playback.replay();
    playback.captureEnded();
    await settled();
    expect(spoken).toEqual([]);
    playback.replay();
    await settled();
    expect(spoken).toHaveLength(1);
  });
  for (const reason of ["off", "background", "unmount", "microphone", "stop"] as const) {
    test(`${reason} invalidates pending native playback`, async () => {
      const gate = deferred();
      const { playback, spoken } = fixture(async () => { await gate.promise; });
      playback.toggle();
      playback.complete(turn);
      switch (reason) {
        case "off": playback.toggle(); break;
        case "background": playback.context(false); break;
        case "unmount": playback.dispose(); break;
        case "microphone": void playback.microphone(); break;
        case "stop": void playback.stop(); break;
      }
      gate.resolve();
      await settled();
      expect(spoken).toEqual([]);
    });
  }
  test("stale native voice lookups and callbacks cannot revive or finish a later utterance", async () => {
    const { playback, callbacks, errors } = fixture();
    playback.toggle();
    playback.complete(turn);
    await settled();
    const old = callbacks[0];
    expect(old?.current()).toBe(true);
    playback.replay();
    await settled();
    expect(old?.current()).toBe(false);
    old?.done();
    old?.error();
    expect(playback.speaking).toBe(true);
    expect(errors).toEqual([]);
    callbacks[1]?.done();
    expect(playback.speaking).toBe(false);
  });
  test("failed stop still silences completions while capturing, and says so", async () => {
    const { playback, errors, spoken } = fixture(async () => { throw new Error("native"); });
    playback.toggle();
    expect(await playback.microphone()).toBe(false);
    playback.complete(turn);
    await settled();
    expect(spoken).toEqual([]);
    expect(errors[0]).toContain("Could not stop speech");
  });
  test("rejected speech promises leave replay available", async () => {
    const errors: string[] = [];
    const playback = new SpokenPlayback({ stop: async () => {}, speak: async () => { throw new Error("no voices"); } }, () => {}, (message) => errors.push(message));
    playback.context(true);
    playback.toggle();
    playback.complete(turn);
    await settled();
    expect(playback.speaking).toBe(false);
    expect(playback.canReplay).toBe(true);
    expect(errors).toHaveLength(1);
  });
  test("backgrounding clears replay and never resumes automatically", async () => {
    const { playback, spoken } = fixture();
    playback.toggle();
    playback.complete(turn);
    await settled();
    playback.context(false);
    playback.context(true);
    playback.replay();
    await settled();
    expect(playback.canReplay).toBe(false);
    expect(spoken).toHaveLength(1);
  });
});
