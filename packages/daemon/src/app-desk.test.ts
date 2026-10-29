import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import {
  AppClient,
  AppDesk,
  AppTyper,
  appPhoneFile,
  parseAppPhoneFile,
  type AppEvent,
} from "./app-desk.js";
import { startFakeApp } from "./testing/fake-gg-app.js";

async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = read();
    if (value) return value;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("the discovery file is parsed strictly, and found under GG_AGENT_DIR or ~/.gg", () => {
  expect(
    parseAppPhoneFile('{"version":1,"port":4100,"token":"t","pid":7,"appVersion":"1"}'),
  ).toEqual({ port: 4100, token: "t", pid: 7, appVersion: "1" });
  expect(parseAppPhoneFile("not json")).toBeUndefined();
  expect(parseAppPhoneFile('{"port":0,"token":"t","pid":7}')).toBeUndefined();
  expect(parseAppPhoneFile('{"port":4100,"pid":7}')).toBeUndefined();
  expect(appPhoneFile({}, "/home/u")).toBe("/home/u/.gg/gg-app-phone.json");
  expect(appPhoneFile({ GG_AGENT_DIR: "/x" }, "/home/u")).toBe("/x/gg-app-phone.json");
});

test("the client speaks the contract: open, draft, send, abort, close, windows, events", async () => {
  const app = await startFakeApp();
  const client = new AppClient({ port: app.port, token: app.token, pid: process.pid });
  expect(await client.ping()).toBe(true);
  const events: AppEvent[] = [];
  let ended = 0;
  const stream = client.events(
    (event) => events.push(event),
    () => ended++,
  );
  const opened = await client.open({ cwd: "/p", agentSessionId: "conv-1", mode: "code" });
  expect(opened).toEqual({
    ok: true,
    value: { sessionId: "win-1", sessionPath: null, agentSessionId: "conv-1" },
  });
  await until(() => events.some((e) => e.type === "windows"), "windows event");
  expect(await client.draft("win-1", "hel")).toBe(true);
  expect(app.windows[0]?.composer).toBe("hel");
  expect(await client.send("win-1", "hello")).toBe(true);
  expect(await client.abort("win-1")).toBe(true);
  expect((await client.windows())?.[0]).toMatchObject({
    sessionId: "win-1",
    agentSessionId: "conv-1",
  });
  // An unknown window is a plain false, not a throw.
  expect(await client.draft("nope", "x")).toBe(false);
  app.emit({ type: "draft", sessionId: "win-1", text: "typed at the Mac" });
  await until(() => events.some((e) => e.type === "draft"), "draft event");
  expect(await client.close("win-1")).toBe(true);
  await until(() => events.some((e) => e.type === "closed"), "closed event");
  expect(events.filter((e) => e.type !== "windows")).toEqual([
    { type: "draft", sessionId: "win-1", text: "typed at the Mac" },
    { type: "closed", sessionId: "win-1" },
  ]);
  expect(app.calls.find((c) => c.route === "send")?.body).toEqual({
    sessionId: "win-1",
    text: "hello",
  });
  stream.stop();
  expect(ended).toBe(0);
  app.stop();
});

test("a wrong token is a 401, and says so", async () => {
  const app = await startFakeApp();
  const client = new AppClient({ port: app.port, token: "wrong", pid: process.pid });
  expect(await client.ping()).toBe(false);
  const opened = await client.open({ cwd: "/p" });
  expect(opened).toMatchObject({ ok: false, status: 401 });
  expect(app.calls).toEqual([]);
  app.stop();
});

test("discovery: available with the file, a live pid and a ping; gone when the file goes", async () => {
  const app = await startFakeApp();
  const changes: boolean[] = [];
  const desk = new AppDesk({ file: app.file, onChange: (a) => changes.push(a), recheckMs: 60_000 });
  await desk.start();
  expect(desk.available).toBe(true);
  // A dead pid is not the app.
  const dead = new AppDesk({ file: app.file, pidAlive: () => false });
  await dead.check();
  expect(dead.available).toBe(false);
  await rm(app.file);
  await desk.check();
  expect(desk.available).toBe(false);
  expect(changes).toEqual([true, false]);
  // Written again (the setting turned back on): found on the next check.
  await writeFile(
    app.file,
    JSON.stringify({ version: 1, port: app.port, token: app.token, pid: process.pid }),
  );
  await desk.check();
  expect(desk.available).toBe(true);
  desk.stop();
  app.stop();
});

test("discovery notices the app going away when its event stream drops", async () => {
  const app = await startFakeApp();
  const changes: boolean[] = [];
  const desk = new AppDesk({ file: app.file, onChange: (a) => changes.push(a), recheckMs: 60_000 });
  await desk.start();
  await until(() => app.calls.some((c) => c.route === "events"), "the stream");
  await rm(app.file);
  app.stop();
  await until(() => changes.at(-1) === false, "gone");
  desk.stop();
});

test("the typer sends the latest draft only, in order, then send, abort and close", async () => {
  const app = await startFakeApp();
  const client = new AppClient({ port: app.port, token: app.token, pid: process.pid });
  await client.open({ cwd: "/p" });
  const typer = new AppTyper(() => client, "win-1", 10);
  typer.draft("h");
  typer.draft("he");
  typer.draft("hello");
  await until(() => app.windows[0]?.composer === "hello", "the draft");
  expect(app.calls.filter((c) => c.route === "draft").map((c) => c.body.text)).toEqual(["hello"]);
  expect(typer.lastTyped).toBe("hello");
  // The same text again is not re-sent.
  typer.draft("hello");
  await Bun.sleep(30);
  expect(app.calls.filter((c) => c.route === "draft")).toHaveLength(1);
  // A draft still waiting is dropped by a send, never landing after it.
  typer.draft("stale");
  expect(await typer.prompt("hello\nworld")).toBe(true);
  await Bun.sleep(30);
  expect(app.calls.map((c) => c.route).filter((r) => r !== "events")).toEqual([
    "open",
    "draft",
    "send",
  ]);
  expect(app.calls.at(-1)?.body.text).toBe("hello\nworld");
  expect(await typer.cancel()).toBe(true);
  expect(await typer.quit()).toBe(true);
  expect(app.windows).toEqual([]);
  // No app: false, not a throw.
  expect(await new AppTyper(() => undefined, "win-1").prompt("x")).toBe(false);
  app.stop();
});
