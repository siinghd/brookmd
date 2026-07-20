// Hand-scaffolded from ubrn's ios/ModuleTemplate.mm. The TurboModule's
// installRustCrate/cleanupRustCrate JSI functions delegate to the C++ installer
// (cpp/flux-md-react-native.cpp). Pending on-device validation.
#import "FluxMdReactNative.h"

namespace uniffi_generated {
using namespace facebook::react;

class JSI_EXPORT RNFluxMdReactNativeSpecJSI : public ObjCTurboModule {
public:
  RNFluxMdReactNativeSpecJSI(const ObjCTurboModule::InitParams &params);
  std::shared_ptr<CallInvoker> callInvoker;
};

static facebook::jsi::Value __hostFunction_FluxMdReactNative_installRustCrate(
    facebook::jsi::Runtime &rt, TurboModule &turboModule, const facebook::jsi::Value *args, size_t count) {
  auto &tm = static_cast<RNFluxMdReactNativeSpecJSI &>(turboModule);
  uint8_t result = fluxmdreactnative::installRustCrate(rt, tm.callInvoker);
  return facebook::jsi::Value(rt, result);
}

static facebook::jsi::Value __hostFunction_FluxMdReactNative_cleanupRustCrate(
    facebook::jsi::Runtime &rt, TurboModule &turboModule, const facebook::jsi::Value *args, size_t count) {
  uint8_t result = fluxmdreactnative::cleanupRustCrate(rt);
  return facebook::jsi::Value(rt, result);
}

RNFluxMdReactNativeSpecJSI::RNFluxMdReactNativeSpecJSI(const ObjCTurboModule::InitParams &params)
    : ObjCTurboModule(params), callInvoker(params.jsInvoker) {
  methodMap_["installRustCrate"] = MethodMetadata{1, __hostFunction_FluxMdReactNative_installRustCrate};
  methodMap_["cleanupRustCrate"] = MethodMetadata{1, __hostFunction_FluxMdReactNative_cleanupRustCrate};
}
} // namespace uniffi_generated

@implementation FluxMdReactNative
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
  return std::make_shared<uniffi_generated::RNFluxMdReactNativeSpecJSI>(params);
}
#endif

@end
