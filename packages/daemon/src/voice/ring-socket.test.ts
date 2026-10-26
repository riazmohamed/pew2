/**
 * A ring goes over the socket as well as the call push: an Android phone has
 * no push service, and its app rings itself from this frame.
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wire } from "@pew2/protocol";
import { Daemon } from "../index.js";

test("a ring is broadcast as voice.ring, naming who and what the call leads with", () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-ring-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PEW2_HOME: join(root, "pew2"),
    GG_AGENT_DIR: join(root, "gg"),
    CODEX_HOME: join(root, "codex"),
  };
  delete env.OPENAI_API_KEY;
  const daemon = new Daemon({ id: "t", name: "t" }, true, env);
  const sent: any[] = [];
  daemon.attach((message) => sent.push(message));
  (daemon.voice as any).host.ring({
    body: "2 things waiting: npm test",
    who: "billing",
    focus: "s1:approval:p1",
  });
  const ring = sent.find((message) => message.t === "voice.ring");
  expect(ring).toMatchObject({
    title: "billing needs you",
    caller: "Pew · billing",
    body: "2 things waiting: npm test",
    focus: "s1:approval:p1",
  });
  expect(ring.ringId).toMatch(/^ring_/);
  expect(wire.ServerMessage.safeParse(ring).success).toBe(true);
  daemon.closeAll();
});

test("a ring with nobody named uses the generic title and no focus", () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-ring-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PEW2_HOME: join(root, "pew2"),
    GG_AGENT_DIR: join(root, "gg"),
    CODEX_HOME: join(root, "codex"),
  };
  const daemon = new Daemon({ id: "t", name: "t" }, true, env);
  const sent: any[] = [];
  daemon.attach((message) => sent.push(message));
  (daemon.voice as any).host.ring({ body: "Done." });
  const ring = sent.find((message) => message.t === "voice.ring");
  expect(ring).toMatchObject({ title: "pew2 needs you", caller: "Pew", body: "Done." });
  expect("focus" in ring).toBe(false);
  daemon.closeAll();
});
