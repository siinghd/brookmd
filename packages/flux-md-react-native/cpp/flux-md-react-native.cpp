// Installer implementation. Delegates to the ubrn-generated JSI host object.
//
// Hand-scaffolded from uniffi-bindgen-react-native's TurboModuleTemplate.cpp. If
// you regenerate the bindings and the namespace/class differs, update the
// `uniffi::flux_md_ffi::NativeFluxMdFfi` references below (see the generated
// cpp/generated/flux_md_ffi.hpp).
#include "flux-md-react-native.h"

#include "generated/flux_md_ffi.hpp"

namespace fluxmdreactnative {
using namespace facebook;

uint8_t installRustCrate(jsi::Runtime &runtime, std::shared_ptr<react::CallInvoker> callInvoker) {
  uniffi::flux_md_ffi::NativeFluxMdFfi::registerModule(runtime, callInvoker);
  return true;
}

uint8_t cleanupRustCrate(jsi::Runtime &runtime) {
  uniffi::flux_md_ffi::NativeFluxMdFfi::unregisterModule(runtime);
  return true;
}
} // namespace fluxmdreactnative
