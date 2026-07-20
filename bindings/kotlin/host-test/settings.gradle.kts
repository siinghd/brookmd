// Standalone JVM build that compiles the SAME generated uniffi Kotlin as the
// `brookmd` Android library (referenced via a srcDir into ../brookmd) and runs the
// wire-golden smoke tests against the host `libbrook_md_ffi.so`. Kept separate
// from the Android build so it needs neither the Android Gradle Plugin nor an
// Android SDK — just a JDK, the runner's Gradle, and JNA.
pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "brookmd-host-test"
