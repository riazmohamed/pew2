import { expect, test } from "bun:test";
import { promptDelivery } from "./promptDelivery";

test("a failed online-only post is refused, never queued", () => {
  expect(promptDelivery(false, "online-only")).toBe("refused");
});
test("manual failed posts retain offline queuing by default", () => {
  expect(promptDelivery(false)).toBe("queue");
  expect(promptDelivery(false, "queue")).toBe("queue");
});
test("both policies accept a successful post", () => {
  expect(promptDelivery(true)).toBe("sent");
  expect(promptDelivery(true, "online-only")).toBe("sent");
});
