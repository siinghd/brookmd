// Installer implementation. Delegates to the ubrn-generated JSI host object.
//
// Hand-scaffolded from uniffi-bindgen-react-native's TurboModuleTemplate.cpp. If
// you regenerate the bindings and the namespace/class differs, update the
// `uniffi::brook_md_ffi::NativeBrookMdFfi` references below (see the generated
// cpp/generated/brook_md_ffi.hpp).
#include "brookmd-react-native.h"

#include "generated/brook_md_ffi.hpp"

namespace brookmdreactnative {
using namespace facebook;

uint8_t installRustCrate(jsi::Runtime &runtime, std::shared_ptr<react::CallInvoker> callInvoker) {
  uniffi::brook_md_ffi::NativeBrookMdFfi::registerModule(runtime, callInvoker);
  return true;
}

uint8_t cleanupRustCrate(jsi::Runtime &runtime) {
  uniffi::brook_md_ffi::NativeBrookMdFfi::unregisterModule(runtime);
  return true;
}
} // namespace brookmdreactnative
