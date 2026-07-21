// Installer implementation. Delegates to the ubrn-generated JSI host object.
//
// Hand-scaffolded from uniffi-bindgen-react-native's TurboModuleTemplate.cpp. The
// ubrn 0.31 JSI host object `NativeBrookMdFfi` is generated at GLOBAL scope (see
// cpp/generated/brook_md_ffi.hpp: `class NativeBrookMdFfi : public jsi::HostObject`
// with `static registerModule`/`unregisterModule`), NOT under a `uniffi::brook_md_ffi`
// namespace. If you regenerate and the class moves, update the `::NativeBrookMdFfi`
// references below.
#include "brookmd-react-native.h"

#include "generated/brook_md_ffi.hpp"

namespace brookmdreactnative {
using namespace facebook;

uint8_t installRustCrate(jsi::Runtime &runtime, std::shared_ptr<react::CallInvoker> callInvoker) {
  ::NativeBrookMdFfi::registerModule(runtime, callInvoker);
  return true;
}

uint8_t cleanupRustCrate(jsi::Runtime &runtime) {
  ::NativeBrookMdFfi::unregisterModule(runtime);
  return true;
}
} // namespace brookmdreactnative
