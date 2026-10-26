/**
 * App entry point.
 *
 * The crypto polyfill is first, and before every other import: the encryption
 * layer needs `crypto.getRandomValues`, Hermes has no Web Crypto at all, and
 * without it the app builds and launches and then throws the first time it seals
 * a frame — which is the moment someone scans a pairing code.
 */
import "./src/cryptoPolyfill";
// After the polyfill (the agreement check draws random bytes), before any frame.
import "./src/ui/nativeCrypto";

import { registerRootComponent } from "expo";
import { LogBox } from "react-native";

// Simulator-only noise: iOS simulators can't mint a push token, and the
// warning's banner sat over the bottom of every screen in development.
LogBox.ignoreLogs(["expo-notifications: obtaining a push token may not work on iOS simulators"]);
import * as SplashScreen from "expo-splash-screen";

import { installCrashHandler } from "./src/crashLog";
import { DUR } from "./src/motion";
import App from "./App";

// Hold the native splash until the app has something real to show.
//
// By default it is dismissed as soon as React commits its first frame, and the
// first frame here is an empty view held on the canvas colour while fonts and
// the stored pairing resolve. That handed the user a dead dark rectangle and
// called it a launch. Holding the splash across that gap costs nothing — it is
// the same colour — and the app appears when it can actually be used.
//
// `App` is responsible for the matching hide, and does it on every path
// including the failure ones, or this would be an app that never opens.
SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden, or no splash on this platform. Not a reason to fail launch.
});
// Dissolve into the app rather than cut to it. The splash draws Pew big and
// centred; home has him higher and smaller, above the cards, so a cut read as
// him jumping up the screen on every launch. Moving him from one to the other
// in JS was tried and recorded: home's first frames stall the UI thread, so
// any animation started then is over before it is seen, and nothing reports
// when the splash has really left the glass. A cross-dissolve is a Core
// Animation transition, which a busy app thread cannot skip. iOS only (the
// option does nothing elsewhere); the length is the app's dissolve.
SplashScreen.setOptions({ fade: true, duration: DUR.dissolve });

// Before anything renders, so a crash during startup is still recorded. Startup
// is where the unexplained ones happen — a native module missing, a stored value
// that no longer parses — and it is the one window `ErrorBoundary` cannot cover,
// because nothing is mounted yet to catch anything.
installCrashHandler();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
