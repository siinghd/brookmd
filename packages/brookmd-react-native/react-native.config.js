// Autolinking config for the brookmd-react-native native module (Android package
// + iOS podspec). React Native's CLI reads this to wire the TurboModule into a
// host app without manual linking.
module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: "android",
        packageImportPath: "import com.brookmdreactnative.BrookMdReactNativePackage;",
        packageInstance: "new BrookMdReactNativePackage()",
      },
      ios: {
        podspecPath: __dirname + "/brookmd-react-native.podspec",
      },
    },
  },
};
