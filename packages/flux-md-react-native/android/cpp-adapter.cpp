// JNI adapter: bridges the Kotlin TurboModule's external methods to the C++
// installer. Hand-scaffolded from ubrn's android/cpp-adapter.cpp. The JNI symbol
// names MUST match the Kotlin package + class:
//   Java_com_fluxmdreactnative_FluxMdReactNativeModule_native{Install,Cleanup}RustCrate
#include <jni.h>
#include <jsi/jsi.h>
#include <ReactCommon/CallInvokerHolder.h>
#include "flux-md-react-native.h"

namespace jsi = facebook::jsi;
namespace react = facebook::react;

extern "C" JNIEXPORT jboolean JNICALL
Java_com_fluxmdreactnative_FluxMdReactNativeModule_nativeInstallRustCrate(
    JNIEnv *env,
    jclass type,
    jlong rtPtr,
    jobject callInvokerHolderJavaObj) {
  using JCallInvokerHolder = facebook::react::CallInvokerHolder;

  auto holderLocal = facebook::jni::make_local(callInvokerHolderJavaObj);
  auto holderRef = facebook::jni::static_ref_cast<JCallInvokerHolder::javaobject>(holderLocal);
  auto *holderCxx = holderRef->cthis();
  auto jsCallInvoker = holderCxx->getCallInvoker();
  auto runtime = reinterpret_cast<jsi::Runtime *>(rtPtr);

  return fluxmdreactnative::installRustCrate(*runtime, jsCallInvoker);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_fluxmdreactnative_FluxMdReactNativeModule_nativeCleanupRustCrate(
    JNIEnv *env,
    jclass type,
    jlong rtPtr) {
  auto runtime = reinterpret_cast<jsi::Runtime *>(rtPtr);
  return fluxmdreactnative::cleanupRustCrate(*runtime);
}
