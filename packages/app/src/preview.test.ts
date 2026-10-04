import { expect, test } from "bun:test";
import { previewUrl, rankServers, rewriteLocalhost } from "./preview";

test("previewUrl addresses the first LAN host", () => {
  expect(previewUrl(["192.168.1.20", "10.0.0.5"], 5173)).toBe("http://192.168.1.20:5173/");
  expect(previewUrl(["192.168.1.20"], 3000, "/app")).toBe("http://192.168.1.20:3000/app");
  expect(previewUrl(["192.168.1.20"], 3000, "app")).toBe("http://192.168.1.20:3000/app");
});

test("previewUrl brackets an IPv6 host", () => {
  expect(previewUrl(["fe80::1"], 3000)).toBe("http://[fe80::1]:3000/");
});

test("no LAN host means no page to open", () => {
  expect(previewUrl([], 3000)).toBeUndefined();
});

test("rewriteLocalhost re-addresses loopback links only", () => {
  const hosts = ["192.168.1.20"];
  expect(rewriteLocalhost("http://localhost:3000/", hosts)).toBe("http://192.168.1.20:3000/");
  expect(rewriteLocalhost("http://127.0.0.1:5173/app?x=1#y", hosts)).toBe(
    "http://192.168.1.20:5173/app?x=1#y",
  );
  expect(rewriteLocalhost("http://[::1]:8080/", hosts)).toBe("http://192.168.1.20:8080/");
  expect(rewriteLocalhost("http://0.0.0.0:8080/", hosts)).toBe("http://192.168.1.20:8080/");
  // The port survives; a bare localhost becomes a bare host.
  expect(rewriteLocalhost("http://localhost/", hosts)).toBe("http://192.168.1.20/");
});

test("rewriteLocalhost leaves everything else alone", () => {
  const hosts = ["192.168.1.20"];
  expect(rewriteLocalhost("https://example.com/", hosts)).toBe("https://example.com/");
  expect(rewriteLocalhost("http://192.168.1.30:3000/", hosts)).toBe("http://192.168.1.30:3000/");
  // `localhost.example.com` is not loopback.
  expect(rewriteLocalhost("http://localhost.example.com/", hosts)).toBe(
    "http://localhost.example.com/",
  );
  expect(rewriteLocalhost("mailto:someone@localhost", hosts)).toBe("mailto:someone@localhost");
  expect(rewriteLocalhost("not a url", hosts)).toBe("not a url");
  // No host known: untouched rather than swallowed.
  expect(rewriteLocalhost("http://localhost:3000/", [])).toBe("http://localhost:3000/");
});

test("rankServers puts the likely site first", () => {
  const ranked = rankServers([
    { port: 42050, process: "OneDrive" },
    { port: 11434, process: "ollama" },
    { port: 5173, process: "node" },
    { port: 3000, process: "bun" },
  ]);
  expect(ranked.map((s) => s.port)).toEqual([3000, 5173, 11434, 42050]);
});
