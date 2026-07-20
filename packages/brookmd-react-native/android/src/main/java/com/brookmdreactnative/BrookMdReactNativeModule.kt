// Hand-scaffolded from ubrn's android/ModuleTemplate.kt. Install-only TurboModule:
// its two native methods (implemented in cpp-adapter.cpp) hand the JSI runtime +
// call-invoker to the C++ installer, which registers the Rust JSI host object.
//
// NOTE: `RNBrookMdReactNativeSpec` is produced by React Native codegen from
// package.json's `codegenConfig.name` during the Gradle build. It does not exist
// until codegen runs — this file will not compile standalone. Pending on-device
// validation.
package com.brookmdreactnative

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder

@ReactModule(name = BrookMdReactNativeModule.NAME)
class BrookMdReactNativeModule(reactContext: ReactApplicationContext) :
  RNBrookMdReactNativeSpec(reactContext) {

  override fun getName(): String = NAME

  external fun nativeInstallRustCrate(runtimePointer: Long, callInvoker: CallInvokerHolder): Boolean
  external fun nativeCleanupRustCrate(runtimePointer: Long): Boolean

  override fun installRustCrate(): Boolean {
    val context = this.reactApplicationContext
    return nativeInstallRustCrate(
      context.javaScriptContextHolder!!.get(),
      context.jsCallInvokerHolder!!,
    )
  }

  override fun cleanupRustCrate(): Boolean {
    return nativeCleanupRustCrate(
      this.reactApplicationContext.javaScriptContextHolder!!.get(),
    )
  }

  companion object {
    const val NAME = "BrookMdReactNative"

    init {
      System.loadLibrary("brookmd-react-native")
    }
  }
}
