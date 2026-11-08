import { expect, test } from "bun:test";
import { shareInFlight } from "./inFlight";

test("a repeat while the first is waiting shares it; nothing new is sent", async () => {
  const live = new Map<string, Promise<string>>();
  let sent = 0;
  let answer!: (value: string) => void;
  const make = () => {
    sent += 1;
    return new Promise<string>((resolve) => (answer = resolve));
  };
  const first = shareInFlight(live, "open|chat|s1", make);
  const second = shareInFlight(live, "open|chat|s1", make);
  const third = shareInFlight(live, "open|chat|s1", make);
  expect(sent).toBe(1);
  answer("ok");
  expect(await Promise.all([first, second, third])).toEqual(["ok", "ok", "ok"]);
  expect(live.size).toBe(0);
});

test("different asks are not merged, and a later ask after the answer goes out again", async () => {
  const live = new Map<string, Promise<number>>();
  let sent = 0;
  const make = () => Promise.resolve(++sent);
  await Promise.all([shareInFlight(live, "a", make), shareInFlight(live, "b", make)]);
  expect(sent).toBe(2);
  await shareInFlight(live, "a", make);
  expect(sent).toBe(3);
});

test("a failed ask is cleared, so the next tap tries again", async () => {
  const live = new Map<string, Promise<void>>();
  await shareInFlight(live, "x", () => Promise.reject(new Error("boom"))).catch(() => {});
  expect(live.size).toBe(0);
});
