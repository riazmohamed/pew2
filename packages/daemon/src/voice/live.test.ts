import { expect, test } from "bun:test";
import { LiveCall, liveSessionConfig, readLiveSettings, type SocketLike } from "./live.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  const socket: SocketLike = {
    readyState: 1,
    send: (data) => void sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return { socket, sent, emit: (event: unknown) => socket.onmessage?.({ data: JSON.stringify(event) }) };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test("the backend's function call runs on the daemon and the backend continues", async () => {
  const { socket, sent, emit } = fakeSocket();
  const ran: string[] = [];
  const call = new LiveCall("c1", "live_1", {
    runTool: async (_id, name, args) => {
      ran.push(`${name} ${args}`);
      return { output: JSON.stringify({ ok: true, say: "Sent to misa_docs." }) };
    },
    onHangup: () => {},
    onFinished: () => {},
    greeting: "Open the call.",
  });
  call.attach("sk-test", () => socket);
  socket.onopen?.({});
  expect(sent[0]).toMatchObject({ type: "session.commentary.append", delegation_id: null, content: "Open the call." });
  emit({ type: "response.event", delegation_id: "d1", event: { type: "response.output_item.done", item: { type: "function_call", call_id: "fc1", name: "tell_agent", arguments: '{"text":"review the doc"}' } } });
  emit({ type: "response.event", delegation_id: "d1", event: { type: "response.completed" } });
  await tick();
  expect(ran).toEqual(['tell_agent {"text":"review the doc"}']);
  const types = sent.map((frame) => frame.type);
  expect(types).toContain("response.item.create");
  expect(types.at(-1)).toBe("response.create");
  call.finish();
});

test("end_call: Pew says goodbye, then the app is told to hang up", async () => {
  const { socket, emit } = fakeSocket();
  let hung = false;
  LiveCall.HANGUP_DELAY_MS = 5;
  const call = new LiveCall("c2", "live_2", {
    runTool: async () => ({ output: "{}", hangUp: true }),
    onHangup: () => (hung = true),
    onFinished: () => {},
  });
  call.attach("sk-test", () => socket);
  emit({ type: "response.event", delegation_id: "d", event: { type: "response.output_item.done", item: { type: "function_call", call_id: "fc", name: "end_call", arguments: "{}" } } });
  emit({ type: "response.event", delegation_id: "d", event: { type: "response.completed" } });
  await tick(30);
  expect(hung).toBe(true);
  call.finish();
});

test("news goes in as commentary (spoken) or thinking (kept)", () => {
  const { socket, sent } = fakeSocket();
  const call = new LiveCall("c3", "live_3", { runTool: async () => ({ output: "{}" }), onHangup: () => {}, onFinished: () => {} });
  call.attach("sk-test", () => socket);
  call.note("misa_docs finished: the brief is reviewed.", true);
  call.note("misa_docs started working.", false);
  call.typed("check the build", false);
  expect(sent.map((frame) => frame.type)).toEqual(["session.commentary.append", "session.thinking.append", "session.instructions.append"]);
  call.finish();
});

test("live settings: needs an API key, and 'engine: realtime' switches it off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pew2-live-"));
  expect(await readLiveSettings(dir, {})).toBeUndefined();
  await writeFile(join(dir, "voice.json"), JSON.stringify({ openaiApiKey: "sk-abc" }));
  expect(await readLiveSettings(dir, {})).toMatchObject({ apiKey: "sk-abc", backendModel: "gpt-6-luna" });
  await writeFile(join(dir, "voice.json"), JSON.stringify({ openaiApiKey: "sk-abc", engine: "realtime" }));
  expect(await readLiveSettings(dir, {})).toBeUndefined();
  const config = liveSessionConfig({ apiKey: "k", voice: "vesper", backendModel: "gpt-6-luna" }, "FULL", "BRIEF", [{ type: "function", name: "tell_agent" }]);
  expect(config).toMatchObject({ model: "gpt-live-1", delegation: { type: "responses", responses: { model: "gpt-6-luna", tools: [{ name: "tell_agent" }] } } });
});
