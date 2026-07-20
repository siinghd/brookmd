// Standalone Gradle build for the `brookmd` Android library.
//
// It is deliberately decoupled from the `host-test` build next door: the JVM
// golden test must be runnable (and must pass) without configuring the Android
// Gradle Plugin or requiring an Android SDK, so the two live in separate builds
// that only share the generated Kotlin source on disk (via a srcDir reference).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "brookmd"
