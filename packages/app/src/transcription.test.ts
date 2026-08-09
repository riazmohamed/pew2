import { describe, expect, test } from "bun:test";
import {
  applyTranscript,
  beginDictation,
  cancelDictation,
  dictationMessage,
} from "./transcription";

describe("applyTranscript", () => {
  test("interim results replace rather than accumulate", () => {
    // The bug this rule exists for: each interim result restates the whole
    // utterance, so appending yields "hello hello there hello there world".
    let state = beginDictation("");
    let draft = "";
    for (const interim of ["hello", "hello there", "hello there world"]) {
      ({ draft, state } = applyTranscript(state, interim));
    }
    expect(draft).toBe("hello there world");
  });

  test("dictation appends to text already typed", () => {
    const { draft } = applyTranscript(beginDictation("fix the"), "login bug");
    expect(draft).toBe("fix the login bug");
  });

  test("existing trailing whitespace is not doubled", () => {
    expect(applyTranscript(beginDictation("fix the "), "login bug").draft).toBe("fix the login bug");
    expect(applyTranscript(beginDictation("run ("), "again").draft).toBe("run (again");
  });

  test("a revision after typed text still replaces only the dictated tail", () => {
    let state = beginDictation("note:");
    let draft: string;
    ({ draft, state } = applyTranscript(state, "check"));
    expect(draft).toBe("note: check");
    ({ draft, state } = applyTranscript(state, "check the logs"));
    expect(draft).toBe("note: check the logs");
  });

  test("an empty transcript leaves the original draft", () => {
    expect(applyTranscript(beginDictation("keep me"), "   ").draft).toBe("keep me");
  });

  test("continuous segments accumulate instead of overwriting each other", () => {
    // The long-dictation bug: under `continuous`, the recogniser starts the next
    // utterance from empty once a segment closes. Without committing the closed
    // segment, sentence two replaced sentence one and a paragraph of speech
    // arrived as its last few words.
    let state = beginDictation("");
    let draft = "";
    for (const [transcript, isFinal] of [
      ["open", false],
      ["open the", false],
      ["Open the file.", true],
      ["then", false],
      ["Then run the tests.", true],
    ] as const) {
      ({ draft, state } = applyTranscript(state, transcript, isFinal));
    }
    expect(draft).toBe("Open the file. Then run the tests.");
  });

  test("an interim result after a final replaces only the unfinished segment", () => {
    let state = beginDictation("note:");
    let draft: string;
    ({ draft, state } = applyTranscript(state, "first thought.", true));
    ({ draft, state } = applyTranscript(state, "secnd", false));
    expect(draft).toBe("note: first thought. secnd");
    ({ draft, state } = applyTranscript(state, "second thought.", false));
    expect(draft).toBe("note: first thought. second thought.");
  });

  test("iOS 18 announcing the same segment final repeatedly does not duplicate it", () => {
    // iOS 18 has no real `isFinal`, so the module infers one from speech
    // duration and warns it "can be emitted multiple times during a continuous
    // session". Committing on every final turned one sentence into three.
    let state = beginDictation("");
    let draft = "";
    for (const transcript of ["this is", "this is just", "this is just a test"]) {
      ({ draft, state } = applyTranscript(state, transcript, true));
    }
    expect(draft).toBe("this is just a test");
  });

  test("a correction that rewrites a word mid-sentence is kept, not silently dropped", () => {
    // "write" → "right" shares no prefix, so it is indistinguishable from a new
    // sentence, and this pins the side we err on deliberately. Guessing
    // "revision" would delete speech the user gave us — the original bug — while
    // guessing "new sentence" leaves a visible stutter they can edit. Duplicated
    // words are a nuisance; missing words are a broken feature.
    let state = beginDictation("");
    let draft: string;
    ({ draft, state } = applyTranscript(state, "the write approach", true));
    ({ draft, state } = applyTranscript(state, "the right approach.", true));
    expect(draft).toBe("the write approach the right approach.");
  });

  test("capitalisation and punctuation added on finalising is not a new sentence", () => {
    let state = beginDictation("");
    let draft: string;
    ({ draft, state } = applyTranscript(state, "so this is just a test dictation", false));
    ({ draft, state } = applyTranscript(state, "So this is just a test dictation.", true));
    expect(draft).toBe("So this is just a test dictation.");
  });

  test("a recogniser shortening a guess it got wrong replaces rather than appends", () => {
    let state = beginDictation("");
    let draft: string;
    ({ draft, state } = applyTranscript(state, "check the logs now", true));
    ({ draft, state } = applyTranscript(state, "check the", true));
    expect(draft).toBe("check the");
  });

  test("a long dictation of many sentences keeps every one of them", () => {
    const sentences = [
      "Looks like it is getting replaced at the moment.",
      "However, if I use the native dictation button it holds a lot more.",
      "So this is just a test dictation.",
      "Sometimes it seems to replace it, at times not.",
    ];
    let state = beginDictation("");
    let draft = "";
    for (const sentence of sentences) {
      // Each sentence arrives as interims, then a final, then iOS repeats the
      // final once more — the exact shape observed on device.
      const half = sentence.slice(0, Math.floor(sentence.length / 2));
      ({ draft, state } = applyTranscript(state, half, false));
      ({ draft, state } = applyTranscript(state, sentence, true));
      ({ draft, state } = applyTranscript(state, sentence, true));
    }
    expect(draft).toBe(sentences.join(" "));
  });
});

describe("cancelDictation", () => {
  test("restores what was typed before the mic was tapped", () => {
    let state = beginDictation("typed");
    ({ state } = applyTranscript(state, "half heard guess"));
    // Interim results are guesses; abandoning must not commit one.
    expect(cancelDictation(state)).toBe("typed");
  });

  test("finalised speech is discarded too, not kept as a partial message", () => {
    let state = beginDictation("typed");
    ({ state } = applyTranscript(state, "a whole sentence.", true));
    ({ state } = applyTranscript(state, "and half of another"));
    expect(cancelDictation(state)).toBe("typed");
  });
});

describe("beginDictation", () => {
  test("a second session dictates onto the result of the first", () => {
    // Stopping and restarting the mic is how a user pauses to think. The new
    // session's typed base is the finished draft, so nothing already said is
    // treated as revisable and overwritten.
    let state = beginDictation("");
    let draft: string;
    ({ draft, state } = applyTranscript(state, "First half.", true));

    state = beginDictation(draft);
    ({ draft, state } = applyTranscript(state, "Second half.", true));
    expect(draft).toBe("First half. Second half.");
  });
});

describe("dictationMessage", () => {
  test("permission failures point at Settings", () => {
    expect(dictationMessage("not-allowed")).toMatch(/Settings/);
    expect(dictationMessage("service-not-allowed")).toMatch(/Settings/);
  });

  test("a deliberate stop is silent", () => {
    // "aborted" is what stopping on purpose reports; a message would accuse the
    // user of an error they did not make.
    expect(dictationMessage("aborted")).toBe("");
  });

  test("an unknown code never leaks the code itself", () => {
    const message = dictationMessage("some-new-code");
    expect(message).not.toContain("some-new-code");
    expect(message.length).toBeGreaterThan(0);
  });
});
