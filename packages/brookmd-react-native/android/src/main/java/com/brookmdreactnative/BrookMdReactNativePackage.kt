// Hand-scaffolded from ubrn's android/PackageTemplate.kt. Registers the
// install-only TurboModule with React Native. Pending on-device validation.
package com.brookmdreactnative

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class BrookMdReactNativePackage : TurboReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == BrookMdReactNativeModule.NAME) BrookMdReactNativeModule(reactContext) else null
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      val infos = HashMap<String, ReactModuleInfo>()
      infos[BrookMdReactNativeModule.NAME] = ReactModuleInfo(
        BrookMdReactNativeModule.NAME,
        BrookMdReactNativeModule.NAME,
        false, // canOverrideExistingModule
        false, // needsEagerInit
        false, // isCxxModule
        true, // isTurboModule
      )
      infos
    }
  }
}
