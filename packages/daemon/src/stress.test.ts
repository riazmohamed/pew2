/**
 * Stress: the daemon under the load a phone in a car, a laptop and a voice
 * call put on it at once. A real daemon process over a real socket, with the
 * echo agent, so every frame crosses the same seams production does.
 *
 * Opt-in (`PEW2_STRESS=1`): it runs for about a minute and spawns a dozen
 * agents, too heavy for every `npm test`. What it proves:
 *
 * - many sessions running turns at once all finish, with their own replies
 * - prompts sent faster than an agent answers queue, and none is lost
 * - a burst of typing drafts lands on the other client in order, ending on the last
 * - clients dropping and reconnecting mid-turn don't wedge it, and catch up
 * - rapid model switches settle on the last one asked for
 * - the daemon stays alive and answers a fresh client at the end
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppClient } from "./testing/app-client.js";
import { startDaemon, type RunningDaemon } from "./testing/daemon-process.js";

const RUN = process.env.PEW2_STRESS === "1";
const DEVICE = "stress-device";
const SESSIONS = Number(process.env.PEW2_STRESS_SESSIONS ?? 12);
const TURNS = 4;

let daemon: RunningDaemon;

(RUN ? describe : describe.skip)("stress", () => {
  beforeAll(async () => {
    daemon = await startDaemon();
  }, 60_000);
  afterAll(async () => {
    await daemon?.stop();
  });

  async function startSession(app: AppClient, requestId: string): Promise<string> {
    app.send({ t: "session.start", requestId, providerId: "echo" });
    const started = await app.waitFor(
      (f) => f.t === "session.started" && f.requestId === requestId,
      `started ${requestId}`,
      30_000,
    );
    return started.sessionId as string;
  }

  /** Every word the agent said in a session, joined. */
  function said(app: AppClient, sessionId: string): string {
    return app.frames
      .filter((f) => f.t === "session.event" && f.sessionId === sessionId)
      .map((f) => (f.payload as any)?.update)
      .filter((u) => u?.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "")
      .join("");
  }

  /** How many messages the session's queue last held (0 once drained). */
  const lastQueue = (app: AppClient, sessionId: string) =>
    (
      (app.frames.filter((f) => f.t === "session.queue" && f.sessionId === sessionId).at(-1)
        ?.queued as unknown[] | undefined) ?? []
    ).length;
  const idles = (app: AppClient, sessionId: string) =>
    app.frames.filter((f) => f.t === "session.idle" && f.sessionId === sessionId).length;

  test(`${SESSIONS} sessions × ${TURNS} prompts each, all at once: every prompt reaches its agent`, async () => {
    const app = await AppClient.connect(daemon, { deviceId: DEVICE });
    const ids = await Promise.all(
      Array.from({ length: SESSIONS }, (_, i) => startSession(app, `s${i}`)),
    );
    const began = Date.now();
    // Every prompt at once: each session's later ones queue behind its first
    // and go out together as ONE follow-up turn (the queue's design), so a
    // session ends after one or two turns with all four words answered.
    for (const [i, sessionId] of ids.entries()) {
      for (let turn = 0; turn < TURNS; turn += 1)
        app.send({ t: "session.prompt", sessionId, text: `job-${i}-${turn}` });
    }
    const allAnswered = (i: number, id: string) =>
      Array.from({ length: TURNS }, (_, turn) => `job-${i}-${turn}`).every((w) =>
        said(app, id).includes(w),
      );
    const deadline = Date.now() + 90_000;
    while (
      Date.now() < deadline &&
      ids.some(
        (id, i) =>
          !allAnswered(i, id) ||
          (app.frames.some((f) => f.t === "session.queue" && f.sessionId === id) &&
            lastQueue(app, id) > 0),
      )
    )
      await Bun.sleep(200);
    const elapsed = Date.now() - began;
    for (const [i, sessionId] of ids.entries()) {
      expect(idles(app, sessionId)).toBeGreaterThanOrEqual(1);
      expect(lastQueue(app, sessionId)).toBe(0);
      const text = said(app, sessionId);
      for (let turn = 0; turn < TURNS; turn += 1) expect(text).toContain(`job-${i}-${turn}`);
      // Nobody else's reply leaked into this session.
      for (let other = 0; other < SESSIONS; other += 1)
        if (other !== i) expect(text).not.toContain(`job-${other}-`);
    }
    console.log(
      `[stress] ${SESSIONS * TURNS} prompts over ${SESSIONS} sessions answered in ${elapsed} ms`,
    );
    app.close();
  }, 120_000);

  test("a burst of 300 typing drafts reaches the other client in order, ending on the last", async () => {
    const phone = await AppClient.connect(daemon, { deviceId: DEVICE });
    const laptop = await AppClient.connect(daemon, { deviceId: DEVICE });
    const sessionId = await startSession(phone, "drafts");
    let text = "";
    for (let i = 0; i < 300; i += 1) {
      text = `${text}${String.fromCharCode(97 + (i % 26))}`;
      phone.send({ t: "session.draft", sessionId, text });
    }
    await laptop.waitFor(
      (f) => f.t === "session.draft" && f.sessionId === sessionId && f.text === text,
      "last draft",
      15_000,
    );
    const seen = laptop.frames
      .filter((f) => f.t === "session.draft" && f.sessionId === sessionId)
      .map((f) => (f.text as string).length);
    // Coalescing is allowed; going backwards is not.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    console.log(`[stress] 300 drafts sent, ${seen.length} delivered, last ${seen.at(-1)} chars`);
    phone.close();
    laptop.close();
  }, 60_000);

  test("20 clients dropping and reconnecting mid-turn: the turn finishes and a newcomer catches up", async () => {
    const owner = await AppClient.connect(daemon, { deviceId: DEVICE });
    const sessionId = await startSession(owner, "churn");
    owner.send({ t: "session.prompt", sessionId, text: "tools please, the long one" });
    // A phone losing signal over and over: sockets dropped without a goodbye.
    for (let i = 0; i < 20; i += 1) {
      const flaky = await AppClient.connect(daemon, {
        deviceId: DEVICE,
        cursors: { [sessionId]: 0 },
      });
      await Bun.sleep(30);
      flaky.kill();
    }
    await owner.waitFor(
      (f) => f.t === "session.idle" && f.sessionId === sessionId,
      "churn idle",
      30_000,
    );
    const late = await AppClient.connect(daemon, { deviceId: DEVICE, cursors: { [sessionId]: 0 } });
    await late.waitFor(
      (f) =>
        (f.t === "session.replay" && f.sessionId === sessionId) ||
        (f.t === "session.event" && f.sessionId === sessionId),
      "catch-up",
      15_000,
    );
    owner.close();
    late.close();
  }, 60_000);

  test("30 model switches back and forth settle on the last one", async () => {
    const app = await AppClient.connect(daemon, { deviceId: DEVICE });
    const sessionId = await startSession(app, "models");
    const values = ["echo-mini", "echo-pro", "echo-max"];
    let last = "";
    for (let i = 0; i < 30; i += 1) {
      last = values[i % 3]!;
      app.send({ t: "session.config", sessionId, configId: "model", value: last });
    }
    const deadline = Date.now() + 20_000;
    const finalOf = () =>
      (
        app.frames.filter((f) => f.t === "session.config" && f.sessionId === sessionId).at(-1)
          ?.configOptions as any[] | undefined
      )?.find((o) => o.id === "model")?.currentValue;
    while (Date.now() < deadline && finalOf() !== last) await Bun.sleep(100);
    const configs = app.frames.filter((f) => f.t === "session.config" && f.sessionId === sessionId);
    const final = (configs.at(-1)?.configOptions as any[] | undefined)?.find(
      (o) => o.id === "model",
    )?.currentValue;
    expect(final).toBe(last);
    app.close();
  }, 60_000);

  test("after all that the daemon is alive and a fresh client is admitted", async () => {
    expect(daemon.died()).toBeUndefined();
    const app = await AppClient.connect(daemon, { deviceId: DEVICE });
    await startSession(app, "after");
    app.close();
  }, 30_000);
});

describe("resume reuses a running conversation", () => {
  test("resuming a conversation already running here re-announces it instead of starting a second agent", async () => {
    const own = await startDaemon();
    try {
      const app = await AppClient.connect(own, { deviceId: DEVICE });
      app.send({ t: "session.start", requestId: "first", providerId: "echo" });
      const started = await app.waitFor(
        (f) => f.t === "session.started" && f.requestId === "first",
        "started",
        30_000,
      );
      const sessionId = started.sessionId as string;
      app.send({ t: "session.prompt", sessionId, text: "hello once" });
      await app.waitFor((f) => f.t === "session.idle" && f.sessionId === sessionId, "idle", 30_000);
      const agentSessionId = (app.frames
        .filter((f) => f.t === "session.config" || f.t === "session.started")
        .map((f) => f.agentSessionId)
        .find(Boolean) ??
        app.frames.find((f) => f.t === "providers" && Array.isArray(f.activeSessions))
          ?.agentSessionId) as string | undefined;
      const known =
        agentSessionId ??
        (await app.waitFor((f) => typeof f.agentSessionId === "string", "agent id", 10_000))
          .agentSessionId;
      // An app back from a crash, reopening the same conversation three times.
      const phone = await AppClient.connect(own, { deviceId: DEVICE });
      for (let i = 0; i < 3; i += 1)
        phone.send({ t: "session.resume", providerId: "echo", agentSessionId: known });
      await Bun.sleep(1500);
      const announced = phone.frames.filter((f) => f.t === "session.started" && f.resumed === true);
      expect(announced.length).toBe(3);
      // Every one is the session already running: no new agent, no new id.
      expect(new Set(announced.map((f) => f.sessionId))).toEqual(new Set([sessionId]));
      const prov = phone.frames.filter((f) => f.t === "providers").at(-1);
      expect(prov?.activeSessions ?? [sessionId]).toEqual([sessionId]);
      expect(own.output()).toContain("is already running as");
      app.close();
      phone.close();
    } finally {
      await own.stop();
    }
  }, 60_000);
});
