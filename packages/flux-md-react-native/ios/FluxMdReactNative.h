// Hand-scaffolded from ubrn's ios/ModuleTemplate.h. Install-only TurboModule.
// `RNFluxMdReactNativeSpec` is produced by React Native codegen from
// package.json's `codegenConfig.name` at build time. Pending on-device validation.
#ifdef __cplusplus
#import "flux-md-react-native.h"
#endif

#ifdef RCT_NEW_ARCH_ENABLED
#import <RNFluxMdReactNativeSpec/RNFluxMdReactNativeSpec.h>

@interface FluxMdReactNative : NSObject <NativeFluxMdReactNativeSpec>
#else
#import <React/RCTBridgeModule.h>

@interface FluxMdReactNative : NSObject <RCTBridgeModule>
#endif

@end
