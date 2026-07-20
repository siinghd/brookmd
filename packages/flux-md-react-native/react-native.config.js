// Autolinking config for the flux-md-react-native native module (Android package
// + iOS podspec). React Native's CLI reads this to wire the TurboModule into a
// host app without manual linking.
module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: "android",
        packageImportPath: "import com.fluxmdreactnative.FluxMdReactNativePackage;",
        packageInstance: "new FluxMdReactNativePackage()",
      },
      ios: {
        podspecPath: __dirname + "/flux-md-react-native.podspec",
      },
    },
  },
};
