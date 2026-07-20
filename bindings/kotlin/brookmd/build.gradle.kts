// The `brookmd` Android library: packages the generated uniffi Kotlin bindings
// plus the per-ABI native libraries (`jniLibs/<abi>/libbrook_md_ffi.so`) into an
// AAR. The .so files are NOT committed — CI (or scripts/build-android.sh in the
// RN package) drops them in before `assembleRelease`; the empty ABI dirs carry
// `.gitkeep` so the layout is present.
//
// NOTE: EXPERIMENTAL. The AGP/Gradle/Kotlin versions below target a modern
// toolchain; adjust them to the Gradle the CI runner provides if they clash.
plugins {
    id("com.android.library") version "8.5.2"
    kotlin("android") version "2.0.21"
}

android {
    namespace = "io.github.siinghd.brookmd"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
        // Instrumented (androidTest) runner for the on-device/emulator wire goldens.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The generated bindings live under src/main/kotlin (default source set),
    // the native libraries under src/main/jniLibs (AGP's default jniLibs dir).
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    // uniffi's generated Kotlin talks to the native library through JNA. On
    // Android the .aar classifier is required (it ships the JNI dispatch libs).
    implementation("net.java.dev.jna:jna:5.14.0@aar")

    // Instrumented (androidTest) wire goldens, run on an x86_64 emulator in
    // device-validate.yml. androidx.test.ext:junit vends AndroidJUnit4 (+ JUnit4);
    // androidx.test:runner vends AndroidJUnitRunner (the testInstrumentationRunner
    // above). kotlin("test") supplies the assertEquals/assertTrue helpers.
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation(kotlin("test"))
}
