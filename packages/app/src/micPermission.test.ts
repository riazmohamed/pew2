import { expect, test } from "bun:test";
import { ensureMicPermission } from "./micPermission";

function source(granted: boolean, answer = granted) {
  const calls = { get: 0, request: 0 };
  return {
    calls,
    get: async () => {
      calls.get++;
      return { granted };
    },
    request: async () => {
      calls.request++;
      return { granted: answer };
    },
  };
}

test("a permission already held is not asked for again", async () => {
  // Asking again starts Android's permission screen, which pauses the app and
  // stopped hands-free before it heard anything.
  const mic = source(true);

  const result = await ensureMicPermission(mic);

  expect(result.granted).toBe(true);
  expect(mic.calls).toEqual({ get: 1, request: 0 });
});

test("a permission not yet held is asked for once", async () => {
  const mic = source(false, true);

  const result = await ensureMicPermission(mic);

  expect(result.granted).toBe(true);
  expect(mic.calls).toEqual({ get: 1, request: 1 });
});

test("a refusal is passed back as a refusal", async () => {
  const mic = source(false, false);

  expect((await ensureMicPermission(mic)).granted).toBe(false);
});
