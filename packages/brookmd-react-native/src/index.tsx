// Package entry for `brookmd-react-native`.
//
// This is the ONLY module that imports `react-native` and the native bindings:
// it binds the real RN primitives into the renderer and wires the ubrn-generated
// `BrookSession` as the default parser. Everything else in the package is
// dependency-injected and testable off-device.
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";

import { makeBrookMarkdown } from "./BrookMarkdown";
import { registerNativeParser } from "./native-pool";
import { makeNativeParser } from "./native-session";
import type { RnPrimitives } from "./components";

// Wire the on-device parser (loads the JSI TurboModule lazily, on first append).
registerNativeParser(makeNativeParser);

/** The real React Native primitives, bound into the DI renderer. */
export const reactNativePrimitives: RnPrimitives = {
  Text,
  View,
  ScrollView,
  Image,
  Pressable,
  Linking,
  StyleSheet,
};

/**
 * `<BrookMarkdown>` — streaming markdown for React Native. Pass a controlled
 * `content` string (it grows in place as tokens arrive) or a caller-owned
 * `client`. Light/dark aware via `useColorScheme`; override per-tag with
 * `components` and colors with `theme`.
 */
export const BrookMarkdown = makeBrookMarkdown({ primitives: reactNativePrimitives, useColorScheme });

// Renderer + client surface.
export { makeBrookMarkdown, useBrookMarkdown, type BrookMarkdownProps, type BrookMarkdownDeps } from "./BrookMarkdown";
export { createComponents, type RnPrimitives } from "./components";
export { resolveTheme, type Theme, type AlertKind, type AlertTheme } from "./theme";
export {
  createBrookClient,
  createNativePool,
  getDefaultNativePool,
  registerNativeParser,
  type MakeParser,
} from "./native-pool";

// Re-export the framework-neutral brookmd pieces a consumer commonly needs, so
// they don't have to depend on `brookmd` directly for types + the client class.
export { BrookClient, BrookPool } from "brookmd/client";
export { htmlToReact, safeUrl } from "brookmd/html-to-react";
export type { Block, Patch, ParserConfig, Components, BlockKind, BlockKindTag } from "brookmd/types";
