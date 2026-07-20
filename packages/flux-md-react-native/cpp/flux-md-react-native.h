// Installer entry points for the flux-md-react-native TurboModule.
//
// Hand-scaffolded from uniffi-bindgen-react-native's TurboModuleTemplate.h. The
// cpp-adapter (Android) and the ObjC++ module (iOS) call installRustCrate() with
// the JSI runtime + CallInvoker; it registers the ubrn-generated NativeFluxMdFfi
// host object (cpp/generated/flux_md_ffi.{hpp,cpp}).
#ifndef FLUXMDREACTNATIVE_H
#define FLUXMDREACTNATIVE_H

#include <cstdint>
#include <jsi/jsi.h>
#include <ReactCommon/CallInvoker.h>

namespace fluxmdreactnative {
using namespace facebook;

uint8_t installRustCrate(jsi::Runtime &runtime, std::shared_ptr<react::CallInvoker> callInvoker);
uint8_t cleanupRustCrate(jsi::Runtime &runtime);
} // namespace fluxmdreactnative

#endif /* FLUXMDREACTNATIVE_H */
