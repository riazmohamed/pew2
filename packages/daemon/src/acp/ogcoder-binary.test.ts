import { expect, test } from "bun:test";
import { resolveOgcoderBin } from "./ogcoder-binary.js";

const HOME = "/home/u";

/** A filesystem stub: only the listed paths are executable. */
function only(...paths: string[]) {
  const set = new Set(paths);
  return (path: string) => set.has(path);
}

test("the fork's name is found on PATH", () => {
  expect(
    resolveOgcoderBin({
      env: { PATH: "/bin:/usr/bin" },
      home: HOME,
      isExecutable: only("/usr/bin/ogcoder"),
    }),
  ).toBe("/usr/bin/ogcoder");
});

test("the upstream name still works when the fork is absent", () => {
  expect(
    resolveOgcoderBin({
      env: { PATH: "/bin" },
      home: HOME,
      isExecutable: only("/bin/ggcoder"),
    }),
  ).toBe("/bin/ggcoder");
});

test("the fork wins on a machine that has both, wherever it lives", () => {
  // The point of ordering by name before directory: `ggcoder` sits earlier in
  // PATH here, and the fork must still win.
  expect(
    resolveOgcoderBin({
      env: { PATH: "/bin:/opt/late" },
      home: HOME,
      isExecutable: only("/bin/ggcoder", "/opt/late/ogcoder"),
    }),
  ).toBe("/opt/late/ogcoder");
});

test("pnpm's bin directory is searched even when PATH omits it", () => {
  // This is the launchd case: the daemon inherits a four-entry PATH, and
  // without the well-known list the agent is invisible to the phone.
  expect(
    resolveOgcoderBin({
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      home: HOME,
      isExecutable: only(`${HOME}/Library/pnpm/ogcoder`),
    }),
  ).toBe(`${HOME}/Library/pnpm/ogcoder`);
});

test("nothing installed resolves to undefined rather than a bare name", () => {
  // A bare name would be spawned and fail with ENOENT, which reads as a pew2
  // bug rather than "you have not installed this".
  expect(
    resolveOgcoderBin({ env: { PATH: "/bin" }, home: HOME, isExecutable: () => false }),
  ).toBeUndefined();
});

test("an absolute override is honoured, and rejected when it is not there", () => {
  expect(
    resolveOgcoderBin({
      env: { PEW2_OGCODER_BIN: "/opt/mine/gg", PATH: "/bin" },
      home: HOME,
      isExecutable: only("/opt/mine/gg", "/bin/ogcoder"),
    }),
  ).toBe("/opt/mine/gg");

  expect(
    resolveOgcoderBin({
      env: { PEW2_OGCODER_BIN: "/opt/gone/gg", PATH: "/bin" },
      home: HOME,
      isExecutable: only("/bin/ogcoder"),
    }),
  ).toBeUndefined();
});

test("a bare-name override is passed through for PATH to resolve", () => {
  expect(
    resolveOgcoderBin({
      env: { PEW2_OGCODER_BIN: "my-wrapper", PATH: "/bin" },
      home: HOME,
      isExecutable: () => false,
    }),
  ).toBe("my-wrapper");
});

test("an empty PATH does not stop the well-known directories being tried", () => {
  expect(
    resolveOgcoderBin({ env: {}, home: HOME, isExecutable: only("/opt/homebrew/bin/ogcoder") }),
  ).toBe("/opt/homebrew/bin/ogcoder");
});
