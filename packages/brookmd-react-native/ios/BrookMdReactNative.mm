// Hand-scaffolded from ubrn's ios/ModuleTemplate.mm. The TurboModule's
// installRustCrate/cleanupRustCrate JSI functions delegate to the C++ installer
// (cpp/brookmd-react-native.cpp). Pending on-device validation.
#import "BrookMdReactNative.h"

namespace uniffi_generated {
using namespace facebook::react;

class JSI_EXPORT RNBrookMdReactNativeSpecJSI : public ObjCTurboModule {
public:
  RNBrookMdReactNativeSpecJSI(const ObjCTurboModule::InitParams &params);
  std::shared_ptr<CallInvoker> callInvoker;
};

static facebook::jsi::Value __hostFunction_BrookMdReactNative_installRustCrate(
    facebook::jsi::Runtime &rt, TurboModule &turboModule, const facebook::jsi::Value *args, size_t count) {
  auto &tm = static_cast<RNBrookMdReactNativeSpecJSI &>(turboModule);
  uint8_t result = brookmdreactnative::installRustCrate(rt, tm.callInvoker);
  return facebook::jsi::Value(rt, result);
}

static facebook::jsi::Value __hostFunction_BrookMdReactNative_cleanupRustCrate(
    facebook::jsi::Runtime &rt, TurboModule &turboModule, const facebook::jsi::Value *args, size_t count) {
  uint8_t result = brookmdreactnative::cleanupRustCrate(rt);
  return facebook::jsi::Value(rt, result);
}

RNBrookMdReactNativeSpecJSI::RNBrookMdReactNativeSpecJSI(const ObjCTurboModule::InitParams &params)
    : ObjCTurboModule(params), callInvoker(params.jsInvoker) {
  methodMap_["installRustCrate"] = MethodMetadata{1, __hostFunction_BrookMdReactNative_installRustCrate};
  methodMap_["cleanupRustCrate"] = MethodMetadata{1, __hostFunction_BrookMdReactNative_cleanupRustCrate};
}
} // namespace uniffi_generated

@implementation BrookMdReactNative
RCT_EXPORT_MODULE()

#ifdef RCT_NEW_ARCH_ENABLED
- (NSNumber *)installRustCrate {
  @throw [NSException exceptionWithName:@"UnreachableException" reason:@"JSI-only." userInfo:nil];
}

- (NSNumber *)cleanupRustCrate {
  @throw [NSException exceptionWithName:@"UnreachableException" reason:@"JSI-only." userInfo:nil];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<uniffi_generated::RNBrookMdReactNativeSpecJSI>(params);
}
#endif

@end
