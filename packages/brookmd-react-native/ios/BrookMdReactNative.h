// Hand-scaffolded from ubrn's ios/ModuleTemplate.h. Install-only TurboModule.
// `RNBrookMdReactNativeSpec` is produced by React Native codegen from
// package.json's `codegenConfig.name` at build time. Pending on-device validation.
#ifdef __cplusplus
#import "brookmd-react-native.h"
#endif

#ifdef RCT_NEW_ARCH_ENABLED
#import <RNBrookMdReactNativeSpec/RNBrookMdReactNativeSpec.h>

@interface BrookMdReactNative : NSObject <NativeBrookMdReactNativeSpec>
#else
#import <React/RCTBridgeModule.h>

@interface BrookMdReactNative : NSObject <RCTBridgeModule>
#endif

@end
