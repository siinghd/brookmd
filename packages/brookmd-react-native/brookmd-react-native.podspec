# Hand-scaffolded from ubrn's ios/module-template.podspec. New-architecture
# TurboModule that vendors the Rust XCFramework (built by scripts/build-ios.sh).
# Pending on-device validation — device builds are CI's job (rn-build.yml).
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
folly_compiler_flags = '-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -Wno-comma -Wno-shorten-64-to-32'

Pod::Spec.new do |s|
  s.name         = "brookmd-react-native"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/siinghd/brookmd.git", :tag => "#{s.version}" }

  # The ObjC++ module + the installer + the generated JSI bindings.
  s.source_files = "ios/**/*.{h,m,mm,swift}", "cpp/**/*.{hpp,cpp,c,h}"
  # The compiled Rust crate, assembled by scripts/build-ios.sh.
  s.vendored_frameworks = "ios/BrookMdFfi.xcframework"
  s.dependency "uniffi-bindgen-react-native", "0.31.0-3"

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency "React-Core"
    if ENV['RCT_NEW_ARCH_ENABLED'] == '1' then
      s.compiler_flags = folly_compiler_flags + " -DRCT_NEW_ARCH_ENABLED=1"
      s.pod_target_xcconfig = {
        "HEADER_SEARCH_PATHS" => "\"$(PODS_ROOT)/boost\"",
        "OTHER_CPLUSPLUSFLAGS" => "-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1",
        "CLANG_CXX_LANGUAGE_STANDARD" => "c++17",
      }
      s.dependency "React-Codegen"
      s.dependency "RCT-Folly"
      s.dependency "RCTRequired"
      s.dependency "RCTTypeSafety"
      s.dependency "ReactCommon/turbomodule/core"
    end
  end
end
