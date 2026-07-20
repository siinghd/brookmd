// React Native codegen spec for the install-only TurboModule.
//
// This is an "installer" TurboModule (new architecture): its two methods hand a
// JSI runtime + call-invoker to the C++ layer (cpp/brookmd-react-native.cpp),
// which registers the ubrn-generated `NativeBrookMdFfi` JSI host object on
// `globalThis`. The actual parser calls then go through JSI directly (see
// src/generated/brook_md_ffi.ts), not over the bridge.
//
// `codegenConfig.name` in package.json (`RNBrookMdReactNativeSpec`) tells RN
// codegen to generate the native Spec base class the Android/iOS modules extend.
import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  /** Register the Rust crate's JSI host object on the runtime. Returns true on
   *  success. Called once, lazily, before the first parser is created. */
  installRustCrate(): boolean;
  /** Tear down the JSI host object (best-effort). */
  cleanupRustCrate(): boolean;
}

// Non-enforcing: the module may be absent on a platform/build without the native
// layer; the caller (native-session) handles a missing module gracefully.
export default TurboModuleRegistry.get<Spec>("BrookMdReactNative");
