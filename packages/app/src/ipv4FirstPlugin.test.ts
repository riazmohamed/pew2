/**
 * The Android WebSocket must try IPv4 before IPv6, or a Wi-Fi network with dead
 * IPv6 stalls every connection for OkHttp's 10 second per-address timeout. The
 * fix lives in a config plugin because `android/` is generated and gitignored,
 * so these tests run the plugin's transform over the shape `expo prebuild`
 * writes and check the result.
 */
import { expect, test } from "bun:test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyIpv4First } = require("../plugins/withIpv4FirstWebSocket.js") as {
  applyIpv4First: (source: string) => string;
};

const TEMPLATE = `package io.github.kenkaiii.pew2

import android.app.Application

class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
`;

test("the DNS order is installed before React Native loads", () => {
  const out = applyIpv4First(TEMPLATE);

  const install = out.indexOf("WebSocketModule.setCustomClientBuilder");
  expect(install).toBeGreaterThan(out.indexOf("super.onCreate()"));
  expect(install).toBeLessThan(out.indexOf("loadReactNative(this)"));
  expect(out).toContain("sortedBy { if (it is Inet4Address) 0 else 1 }");
});

test("every name the installed code uses is imported", () => {
  const out = applyIpv4First(TEMPLATE);

  for (const name of [
    "com.facebook.react.modules.websocket.WebSocketModule",
    "java.net.Inet4Address",
    "java.net.InetAddress",
    "okhttp3.Dns",
  ]) {
    expect(out).toContain(`import ${name}`);
  }
});

test("running prebuild twice does not install it twice", () => {
  const once = applyIpv4First(TEMPLATE);

  expect(applyIpv4First(once)).toBe(once);
});

test("a MainApplication it cannot place the code in fails the build loudly", () => {
  expect(() => applyIpv4First("package x\n\nclass A {}\n")).toThrow(/super.onCreate/);
});
