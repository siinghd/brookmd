# Hand-scaffolded from uniffi-bindgen-react-native's android/CMakeLists.txt.
# Builds the installer + generated bindings and links the imported Rust .so
# (staged into jniLibs/<abi>/ by scripts/build-android.sh). Pending on-device
# validation.
cmake_minimum_required(VERSION 3.13.0)
project(brookmd-react-native)

set(CMAKE_VERBOSE_MAKEFILE ON)
set(CMAKE_CXX_STANDARD 17)

# Locate the uniffi-bindgen-react-native package root (its runtime C++ headers
# live under cpp/includes). ubrn 0.31's package.json does NOT export the
# "./package.json" subpath, so `require.resolve('.../package.json')` throws
# ERR_PACKAGE_PATH_NOT_EXPORTED once Node enforces "exports" (Node >= 22),
# yielding an empty path and a bogus `-I/cpp/includes`. Resolve the main entry
# instead (always exported) and slice back to the package root — a single
# expression (no ';', which CMake would treat as a list separator) that is
# independent of the entry's directory depth.
execute_process(
  COMMAND node -p "require.resolve('uniffi-bindgen-react-native').split(require('path').sep+'uniffi-bindgen-react-native'+require('path').sep)[0]+require('path').sep+'uniffi-bindgen-react-native'"
  OUTPUT_VARIABLE UNIFFI_BINDGEN_PATH
  OUTPUT_STRIP_TRAILING_WHITESPACE
)

include_directories(
  ../cpp
  ../cpp/generated
  ${UNIFFI_BINDGEN_PATH}/cpp/includes
)

add_library(brookmd-react-native SHARED
  ../cpp/brookmd-react-native.cpp
  ../cpp/generated/brook_md_ffi.cpp
  cpp-adapter.cpp
)

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O2 -fexceptions -frtti -fstack-protector-all -Wall")

# 16 KB page-size alignment (required for Android 15+ / 16 KB-page devices).
set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} -Wl,-z,max-page-size=16384")

# Import the Rust cdylib for the current ABI (produced by cargo-ndk).
cmake_path(SET MY_RUST_LIB
  ${CMAKE_SOURCE_DIR}/src/main/jniLibs/${ANDROID_ABI}/libbrook_md_ffi.so
  NORMALIZE
)
add_library(my_rust_lib SHARED IMPORTED)
set_target_properties(my_rust_lib PROPERTIES IMPORTED_LOCATION ${MY_RUST_LIB} IMPORTED_NO_SONAME ON)

find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)
find_library(LOGCAT log)

# React Native >= 0.76 merges its prefab into a single `reactnative` target.
target_link_libraries(brookmd-react-native
  ReactAndroid::reactnative
  ReactAndroid::jsi
  fbjni::fbjni
  ${LOGCAT}
  my_rust_lib
)
