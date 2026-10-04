import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  chromeBinary,
  listeningPorts,
  parseLsof,
  parseSs,
  snapshot,
  validatePreviewPath,
} from "./preview.js";

const LSOF = [
  "p830",
  "cbun",
  "f4",
  "n*:8787",
  "p845",
  "collama",
  "f4",
  "n127.0.0.1:11434",
  "p1137",
  "cOneDrive Sync Service",
  "f38",
  "n[::1]:42050",
  "f39",
  "n[::1]:42050",
  "p1",
  "claunchd",
  "f5",
  "n*:22",
  "",
].join("\n");

describe("parseLsof", () => {
  test("reads command and port per socket, sorted, deduplicated", () => {
    expect(parseLsof(LSOF)).toEqual([
      { port: 8787, process: "bun" },
      { port: 11434, process: "ollama" },
      { port: 42050, process: "OneDrive Sync Service" },
    ]);
  });

  test("drops system ports: nothing there is a dev server", () => {
    expect(parseLsof("p1\ncsshd\nf5\nn*:22\n")).toEqual([]);
  });

  test("empty output is an empty list", () => {
    expect(parseLsof("")).toEqual([]);
  });
});

describe("parseSs", () => {
  test("reads the local port and the owning process when shown", () => {
    const output = [
      'LISTEN 0 511 *:5173 *:* users:(("node",pid=41,fd=22))',
      "LISTEN 0 128 127.0.0.1:631 0.0.0.0:*",
      'LISTEN 0 4096 [::]:3000 [::]:* users:(("bun",pid=9,fd=4))',
      "",
    ].join("\n");
    expect(parseSs(output)).toEqual([
      { port: 3000, process: "bun" },
      { port: 5173, process: "node" },
    ]);
  });
});

describe("listeningPorts", () => {
  test("a missing tool is no servers, not an error", async () => {
    const exec = (() => Promise.reject(new Error("ENOENT"))) as never;
    expect(await listeningPorts("darwin", exec)).toEqual([]);
  });

  test("lsof's exit 1 for an empty result still yields what it printed", async () => {
    const exec = (() => Promise.reject(Object.assign(new Error("exit 1"), { stdout: "" }))) as never;
    expect(await listeningPorts("darwin", exec)).toEqual([]);
  });

  test("windows is unsupported and says so as an empty list", async () => {
    const exec = (() => Promise.reject(new Error("must not be called"))) as never;
    expect(await listeningPorts("win32", exec)).toEqual([]);
  });
});

describe("validatePreviewPath", () => {
  test("absent or empty is the root", () => {
    expect(validatePreviewPath(undefined)).toBe("/");
    expect(validatePreviewPath("")).toBe("/");
  });

  test("an ordinary path with a query passes through", () => {
    expect(validatePreviewPath("/app/settings?tab=1#x")).toBe("/app/settings?tab=1#x");
  });

  test.each([
    "http://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "settings",
    "/a/../b",
    "/a b",
  ])("refuses %s", (path) => {
    expect(() => validatePreviewPath(path)).toThrow();
  });
});

describe("chromeBinary", () => {
  test("an explicit override wins", () => {
    expect(chromeBinary("darwin", { PEW2_CHROME: "/opt/chrome" })).toBe("/opt/chrome");
  });

  test("nothing installed is undefined, not a throw", () => {
    expect(chromeBinary("linux", { PATH: "/nonexistent" })).toBeUndefined();
  });
});

describe("snapshot", () => {
  test("a port nothing listens on is refused before Chrome is involved", async () => {
    await expect(
      snapshot({ port: 3000, listening: [{ port: 3001, process: "node" }] }),
    ).rejects.toThrow("Nothing is listening on port 3000");
  });

  test("a bad path is refused before Chrome is involved", async () => {
    await expect(
      snapshot({ port: 3000, path: "//x", listening: [{ port: 3000, process: "node" }] }),
    ).rejects.toThrow("single '/'");
  });

  test("no browser is a sentence for the user", async () => {
    await expect(
      snapshot({
        port: 3000,
        listening: [{ port: 3000, process: "node" }],
        platform: "linux",
        env: { PATH: "/nonexistent" },
      }),
    ).rejects.toThrow("Install Google Chrome");
  });

  // Real Chrome, real page: the only proof the flags and the completion
  // signal still hold for the browser actually installed here.
  const chrome = chromeBinary();
  test.skipIf(!chrome)(
    "renders a local page as a png data uri",
    async () => {
      const server = createServer((_, res) => {
        res.setHeader("content-type", "text/html");
        res.end("<html><body style='background:#f00'><h1>pew2</h1></body></html>");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      try {
        const image = await snapshot({
          port,
          listening: [{ port, process: "bun" }],
          width: 400,
        });
        expect(image.mimeType).toBe("image/png");
        expect(image.dataUri.startsWith("data:image/png;base64,")).toBe(true);
        expect(image.dataUri.length).toBeGreaterThan(1_000);
      } finally {
        server.close();
      }
    },
    30_000,
  );
});
