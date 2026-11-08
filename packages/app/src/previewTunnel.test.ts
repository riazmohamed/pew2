import { expect, test } from "bun:test";
import { applyTunnelUpdate, mergeTunnelList, tunnelView } from "./preview";

test("an open link is stored with its address and expiry", () => {
  const map = applyTunnelUpdate(undefined, {
    port: 5173,
    status: "open",
    url: "https://x.ngrok-free.dev/?pew2_key=s",
    idleCloseAt: 1_000,
  });
  expect(map[5173]).toEqual({
    status: "open",
    url: "https://x.ngrok-free.dev/?pew2_key=s",
    idleCloseAt: 1_000,
  });
});

test("a plain close forgets the link; a close with a reason keeps the reason", () => {
  const open = applyTunnelUpdate(undefined, { port: 3000, status: "open", url: "u" });
  expect(applyTunnelUpdate(open, { port: 3000, status: "closed" })[3000]).toBeUndefined();
  const idle = applyTunnelUpdate(open, { port: 3000, status: "closed", message: "Idle." });
  expect(idle[3000]).toEqual({ status: "closed", message: "Idle." });
});

test("a fresh list keeps requests in flight and takes the daemon's open links", () => {
  const merged = mergeTunnelList(
    { 1: { status: "starting" }, 2: { status: "error", message: "x" }, 3: { status: "open" } },
    [{ port: 4, status: "open", url: "u4" }],
  );
  expect(merged).toEqual({ 1: { status: "starting" }, 4: { status: "open", url: "u4" } });
  expect(mergeTunnelList(undefined, undefined)).toEqual({});
});

test("the sheet's states: idle, starting, open with expiry, error", () => {
  expect(tunnelView(undefined)).toEqual({ label: "Open anywhere", busy: false, closable: false });
  expect(tunnelView({ status: "starting" }).busy).toBe(true);
  const at = new Date(2026, 10, 8, 14, 5).getTime();
  const open = tunnelView({ status: "open", url: "u", idleCloseAt: at });
  expect(open.closable).toBe(true);
  expect(open.note).toContain("14:05");
  const error = tunnelView({ status: "error", message: "ngrok is not signed in" });
  expect(error).toEqual({
    label: "Open anywhere",
    busy: false,
    closable: false,
    note: "ngrok is not signed in",
  });
});
