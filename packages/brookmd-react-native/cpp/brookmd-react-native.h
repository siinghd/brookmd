// Installer entry points for the brookmd-react-native TurboModule.
//
// Hand-scaffolded from uniffi-bindgen-react-native's TurboModuleTemplate.h. The
// cpp-adapter (Android) and the ObjC++ module (iOS) call installRustCrate() with
// the JSI runtime + CallInvoker; it registers the ubrn-generated NativeBrookMdFfi
// host object (cpp/generated/brook_md_ffi.{hpp,cpp}).
#ifndef BROOKMDREACTNATIVE_H
#define BROOKMDREACTNATIVE_H

#include <cstdint>
#include <jsi/jsi.h>
#include <ReactCommon/CallInvoker.h>

namespace brookmdreactnative {
using namespace facebook;

uint8_t installRustCrate(jsi::Runtime &runtime, std::shared_ptr<react::CallInvoker> callInvoker);
uint8_t cleanupRustCrate(jsi::Runtime &runtime);
} // namespace brookmdreactnative

#endif /* BROOKMDREACTNATIVE_H */
