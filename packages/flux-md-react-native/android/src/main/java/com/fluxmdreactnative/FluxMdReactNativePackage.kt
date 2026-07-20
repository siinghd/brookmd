// Hand-scaffolded from ubrn's android/PackageTemplate.kt. Registers the
// install-only TurboModule with React Native. Pending on-device validation.
package com.fluxmdreactnative

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class FluxMdReactNativePackage : TurboReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == FluxMdReactNativeModule.NAME) FluxMdReactNativeModule(reactContext) else null
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      val infos = HashMap<String, ReactModuleInfo>()
      infos[FluxMdReactNativeModule.NAME] = ReactModuleInfo(
        FluxMdReactNativeModule.NAME,
        FluxMdReactNativeModule.NAME,
        false, // canOverrideExistingModule
        false, // needsEagerInit
        false, // isCxxModule
        true, // isTurboModule
      )
      infos
    }
  }
}
