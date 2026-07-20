# Hand-scaffolded from uniffi-bindgen-react-native's android/CMakeLists.txt.
# Builds the installer + generated bindings and links the imported Rust .so
# (staged into jniLibs/<abi>/ by scripts/build-android.sh). Pending on-device
# validation.
cmake_minimum_required(VERSION 3.13.0)
project(flux-md-react-native)

set(CMAKE_VERBOSE_MAKEFILE ON)
set(CMAKE_CXX_STANDARD 17)

# Locate the uniffi-bindgen-react-native runtime C++ headers.
execute_process(
  COMMAND node -p "require.resolve('uniffi-bindgen-react-native/package.json')"
  OUTPUT_VARIABLE UNIFFI_BINDGEN_PATH
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
get_filename_component(UNIFFI_BINDGEN_PATH "${UNIFFI_BINDGEN_PATH}" DIRECTORY)

include_directories(
  ../cpp
  ../cpp/generated
  ${UNIFFI_BINDGEN_PATH}/cpp/includes
)

add_library(flux-md-react-native SHARED
  ../cpp/flux-md-react-native.cpp
  ../cpp/generated/flux_md_ffi.cpp
  cpp-adapter.cpp
)

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O2 -fexceptions -frtti -fstack-protector-all -Wall")

# 16 KB page-size alignment (required for Android 15+ / 16 KB-page devices).
set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} -Wl,-z,max-page-size=16384")

# Import the Rust cdylib for the current ABI (produced by cargo-ndk).
cmake_path(SET MY_RUST_LIB
  ${CMAKE_SOURCE_DIR}/src/main/jniLibs/${ANDROID_ABI}/libflux_md_ffi.so
  NORMALIZE
)
add_library(my_rust_lib SHARED IMPORTED)
set_target_properties(my_rust_lib PROPERTIES IMPORTED_LOCATION ${MY_RUST_LIB} IMPORTED_NO_SONAME ON)

find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)
find_library(LOGCAT log)

# React Native >= 0.76 merges its prefab into a single `reactnative` target.
target_link_libraries(flux-md-react-native
  ReactAndroid::reactnative
  ReactAndroid::jsi
  fbjni::fbjni
  ${LOGCAT}
  my_rust_lib
)
