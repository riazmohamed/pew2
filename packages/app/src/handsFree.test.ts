import { expect, test } from "bun:test";
import { HandsFreeLoop, type HandsFreeContext } from "./handsFree";
import { SpokenPlayback } from "./spokenReply";

function fixture(captureStarted: () => void = () => {}) {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 0;
  const context: HandsFreeContext = {
    sessionId: "one", contextKey: "project/provider/one", foreground: true,
    online: true, live: true, busy: false, loading: false, permission: false,
    voiceEnabled: true, speaking: false, manualRecording: false,
    draft: "", draftVersion: 0, attachments: 0,
  };
  const sent: string[] = [];
  const starts: number[] = [];
  let finishes = 0;
  let cancels = 0;
  let allowed = true;
  let rejectStart = false;
  const loop = new HandsFreeLoop({
    read: () => context,
    start: async (ticket) => { starts.push(ticket); captureStarted(); if (rejectStart) throw new Error("permission"); return true; },
    finish: () => { finishes++; },
    cancel: () => { cancels++; },
    stopPlayback: () => { context.speaking = false; },
    send: (sessionId, version) => {
      expect(sessionId).toBe(context.sessionId!);
      expect(version).toBe(context.draftVersion);
      if (!allowed) return false;
      sent.push(context.draft);
      context.draft = "";
      context.draftVersion++;
      context.busy = true;
      return true;
    },
    changed: () => {},
  }, {
    after: (ms, run) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + ms, run });
      return () => { timers.delete(id); };
    },
  });
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > end) break;
      now = first[1].at;
      timers.delete(first[0]);
      first[1].run();
    }
    now = end;
  }
  const hear = (text: string, ticket = loop.ticket) => {
    context.draft = text;
    context.draftVersion++;
    loop.transcript(ticket, text);
  };
  const listen = () => { loop.enable(); loop.nativeStarted(loop.ticket); };
  return { loop, context, timers, starts, sent, advance, hear, listen,
    finishes: () => finishes, cancels: () => cancels,
    refuse: () => { allowed = false; }, rejectStart: () => { rejectStart = true; } };
}

test("real playback and loop alternate twice without capture/playback overlap", async () => {
  const f = fixture(() => {
    expect(playback.speaking).toBe(false);
    void playback.microphone();
  });
  const spoken: string[] = [];
  let done = () => {};
  let ticket = 0;
  const playback = new SpokenPlayback({
    stop: async () => {},
    speak: async (text, complete) => {
      expect(playback.capturing).toBe(false);
      spoken.push(text); done = complete;
    },
  }, () => { f.context.speaking = playback.speaking; }, () => {}, (event) => {
    f.loop.playbackEnded(ticket, event.id, event.sessionId, event.outcome);
  });
  playback.toggle(); f.listen();
  for (let i = 1; i <= 2; i++) {
    f.hear(`Prompt ${i}`); f.advance(5_000);
    expect(spoken).toHaveLength(i - 1);
    playback.captureEnded(); f.loop.nativeEnded(f.loop.ticket); f.context.busy = false;
    const reply = { id: `one:${i}`, sessionId: "one", text: "Complete reply. With details." };
    expect(f.loop.completion(reply)).toBe(true); ticket = f.loop.ticket;
    playback.complete(reply);
    for (let j = 0; j < 20; j++) await Promise.resolve();
    expect(f.starts).toHaveLength(i);
    expect(spoken).toHaveLength(i);
    done();
    expect(f.starts).toHaveLength(i + 1);
    expect(playback.capturing).toBe(true);
    f.loop.nativeStarted(f.loop.ticket);
  }
});

test("off owns no timers, capture, playback, send or permission-answer effect", () => {
  const f = fixture();
  f.advance(100_000);
  expect(f.loop.enabled).toBe(false);
  expect(f.timers.size).toBe(0);
  expect(f.starts).toEqual([]);
  expect(f.sent).toEqual([]);
});

test("two complete listen/send/speak/listen turns without manual activation", () => {
  const f = fixture();
  f.listen();
  for (let i = 1; i <= 2; i++) {
    f.hear(`Turn ${i}`);
    f.advance(2_000);
    expect(f.loop.state).toBe("pending-send");
    f.advance(3_000);
    expect(f.loop.state).toBe("finalising");
    expect(f.sent).toHaveLength(i - 1);
    f.hear(`Turn ${i}, final revision.`);
    f.loop.nativeEnded(f.loop.ticket);
    expect(f.loop.state).toBe("waiting");
    expect(f.sent[i - 1]).toBe(`Turn ${i}, final revision.`);
    expect(f.starts).toHaveLength(i);
    f.context.busy = false;
    const turn = { id: `one:${i}`, sessionId: "one", text: "Reply." };
    expect(f.loop.completion(turn)).toBe(true);
    f.context.speaking = true;
    f.advance(10_000);
    expect(f.starts).toHaveLength(i);
    f.context.speaking = false;
    f.loop.playbackEnded(f.loop.ticket, turn.id, "one", "done");
    expect(f.loop.state).toBe("starting");
    f.loop.nativeStarted(f.loop.ticket);
  }
  expect(f.starts).toHaveLength(3);
});

test("no transcript means no send and a bounded empty cycle", () => {
  const f = fixture(); f.listen(); f.advance(30_000);
  expect(f.loop.state).toBe("paused");
  expect(f.sent).toEqual([]);
  expect(f.timers.size).toBe(0);
});

test("new interim activity resets both windows, even an unchanged recognition result", () => {
  const f = fixture(); f.listen(); f.hear("First phrase.");
  f.advance(4_999); f.hear("First phrase."); f.advance(4_999);
  expect(f.finishes()).toBe(0);
  f.hear("First phrase. More words."); f.advance(5_000);
  expect(f.finishes()).toBe(1);
  expect(f.sent).toEqual([]); // Neither punctuation nor a final hint sends.
});

test("missing native end pauses and preserves finalising text", () => {
  const f = fixture(); f.listen(); f.hear("Keep this."); f.advance(8_000);
  expect(f.loop.state).toBe("paused"); expect(f.context.draft).toBe("Keep this.");
  f.loop.nativeEnded(f.loop.ticket); f.advance(60_000);
  expect(f.sent).toEqual([]); expect(f.starts).toHaveLength(1);
});

test("unexpected native end does not send an incomplete guess", () => {
  const f = fixture(); f.listen(); f.hear("Still thinking"); f.loop.nativeEnded(f.loop.ticket);
  f.advance(20_000); expect(f.sent).toEqual([]); expect(f.loop.state).toBe("paused");
});

test("duplicate native end cannot send twice or disturb the wait", () => {
  const f = fixture(); f.listen(); f.hear("One message"); f.advance(5_000);
  f.loop.nativeEnded(f.loop.ticket); f.loop.nativeEnded(f.loop.ticket);
  expect(f.sent).toHaveLength(1); expect(f.loop.state).toBe("waiting");
});

for (const phrase of ["stop listening", "Stop listening."]) {
  test(`standalone ${phrase} disables without sending`, () => {
    const f = fixture(); f.listen(); f.hear("A thought"); f.advance(2_000);
    f.hear(phrase); f.advance(20_000);
    expect(f.loop.state).toBe("off"); expect(f.sent).toEqual([]);
  });
}

test("stop words inside an instruction are not treated as a command", () => {
  const f = fixture(); f.listen(); f.hear("Explain how to stop listening.");
  expect(f.loop.state).toBe("listening");
});

for (const change of ["online", "foreground", "live", "voiceEnabled"] as const) {
  test(`${change} loss cancels timers without automatic recovery`, () => {
    const f = fixture(); f.listen(); f.hear("Keep me"); f.advance(2_000);
    f.context[change] = false; f.loop.reconcile(); f.context[change] = true;
    f.loop.reconcile(); f.advance(60_000);
    expect(f.loop.state).toBe("paused"); expect(f.sent).toEqual([]);
    expect(f.context.draft).toBe("Keep me"); expect(f.timers.size).toBe(0);
  });
}

for (const change of ["busy", "loading", "permission"] as const) {
  test(`${change} appearing immediately before send refuses`, () => {
    const f = fixture(); f.listen(); f.hear("Never approve this"); f.advance(5_000);
    f.context[change] = true; f.loop.nativeEnded(f.loop.ticket);
    expect(f.loop.state).toBe("paused"); expect(f.sent).toEqual([]);
  });
}

test("manual draft edit, even back to the same text, invalidates ownership", () => {
  const f = fixture(); f.listen(); f.hear("Unchanged text"); f.advance(2_000);
  f.context.draftVersion++; f.advance(3_000);
  expect(f.loop.state).toBe("paused"); expect(f.sent).toEqual([]);
});

test("refused online-only send leaves text and pauses", () => {
  const f = fixture(); f.listen(); f.hear("Do not queue me"); f.advance(5_000);
  f.refuse(); f.loop.nativeEnded(f.loop.ticket);
  expect(f.loop.state).toBe("paused"); expect(f.context.draft).toBe("Do not queue me");
});

for (const change of ["sessionId", "contextKey"] as const) {
  test(`stale ${change} cannot receive a prompt`, () => {
    const f = fixture(); f.listen(); f.hear("Wrong destination"); f.advance(5_000);
    f.context[change] = "other"; f.loop.nativeEnded(f.loop.ticket);
    expect(f.sent).toEqual([]); expect(f.loop.state).toBe("paused");
  });
}

test("old generation cannot move a resumed loop", () => {
  const f = fixture(); f.listen(); const stale = f.loop.ticket;
  f.loop.pause(); f.listen(); f.loop.nativeEnded(stale); f.loop.failed(stale);
  f.loop.transcript(stale, "stop listening");
  expect(f.loop.state).toBe("listening"); expect(f.sent).toEqual([]);
});

test("permission/start rejection is handled without retries", async () => {
  const f = fixture(); f.rejectStart(); f.loop.enable();
  await Promise.resolve(); await Promise.resolve();
  expect(f.loop.state).toBe("paused"); expect(f.starts).toHaveLength(1);
  expect(f.timers.size).toBe(0);
});

for (const outcome of ["stopped", "error"] as const) {
  test(`${outcome} playback never restarts capture`, () => {
    const f = fixture(); f.listen(); f.hear("Prompt"); f.advance(5_000);
    f.loop.nativeEnded(f.loop.ticket); f.context.busy = false;
    f.loop.completion({ id: "one:1", sessionId: "one", text: "Reply" });
    f.loop.playbackEnded(f.loop.ticket, "one:1", "one", outcome);
    expect(f.loop.state).toBe("paused"); expect(f.starts).toHaveLength(1);
  });
}

test("other conversation, duplicate, missing and background completions cannot rearm", () => {
  const f = fixture(); f.listen(); f.hear("Prompt"); f.advance(5_000);
  f.loop.nativeEnded(f.loop.ticket); f.context.busy = false;
  expect(f.loop.completion({ id: "other:1", sessionId: "other", text: "Reply" })).toBe(false);
  expect(f.loop.state).toBe("waiting");
  const turn = { id: "one:1", sessionId: "one", text: "Reply" };
  expect(f.loop.completion(turn)).toBe(true);
  expect(f.loop.completion(turn)).toBe(false);
  f.context.foreground = false; f.loop.reconcile();
  f.loop.playbackEnded(f.loop.ticket, turn.id, "one", "done");
  expect(f.starts).toHaveLength(1);
  f.context.foreground = true; f.listen(); f.hear("Next"); f.advance(5_000);
  f.loop.nativeEnded(f.loop.ticket); f.context.busy = false;
  expect(f.loop.completion(turn)).toBe(false);
  expect(f.loop.completion({ ...turn, id: "one:2", text: "" })).toBe(false);
  expect(f.loop.state).toBe("paused");
});

test("eligibility reads the current draft after it is cleared without a root render", () => {
  const f = fixture(); f.context.draft = "Typed draft";
  expect(f.loop.unavailable()).toBe("Send or clear your draft first.");
  f.context.draft = ""; f.context.draftVersion++;
  expect(f.loop.unavailable()).toBeUndefined();
  f.loop.enable(); expect(f.loop.state).toBe("starting");
});

test("manual edits while already paused do not keep cancelling native audio", () => {
  const f = fixture(); f.listen(); f.loop.pause(); const cancels = f.cancels();
  f.loop.pause(); f.loop.pause();
  expect(f.cancels()).toBe(cancels);
});

test("an error or permission sheet interrupts the wait rather than resuming from partial prose", () => {
  const f = fixture(); f.listen(); f.hear("Prompt"); f.advance(5_000);
  f.loop.nativeEnded(f.loop.ticket);
  f.context.interruption = "Conversation failed"; f.loop.reconcile();
  expect(f.loop.state).toBe("paused");
  expect(f.loop.completion({ id: "one:1", sessionId: "one", text: "Partial reply" })).toBe(false);
});

test("native results are refused before replacing a manually changed draft", () => {
  const f = fixture(); f.listen(); const ticket = f.loop.ticket;
  f.context.draft = "Manual text"; f.context.draftVersion++;
  expect(f.loop.captureCurrent(ticket)).toBe(false);
  expect(f.context.draft).toBe("Manual text"); expect(f.loop.state).toBe("paused");
});

test("activation does not erase drafts or permit manual capture, audio, attachments or approvals", () => {
  for (const patch of [{ draft: "typed" }, { attachments: 1 }, { speaking: true }, { manualRecording: true }, { permission: true }]) {
    const f = fixture(); Object.assign(f.context, patch); f.loop.enable();
    expect(f.loop.state).toBe("off"); expect(f.starts).toEqual([]);
    expect(f.loop.reason.length).toBeGreaterThan(0);
  }
});

test("unmount cancels capture and all timers; late callbacks stay inert", () => {
  const f = fixture(); f.listen(); f.hear("Unsent"); const ticket = f.loop.ticket;
  f.loop.dispose(); f.advance(60_000); f.loop.nativeEnded(ticket); f.loop.nativeStarted(ticket);
  expect(f.loop.state).toBe("off"); expect(f.sent).toEqual([]);
  expect(f.timers.size).toBe(0); expect(f.cancels()).toBe(1);
});
