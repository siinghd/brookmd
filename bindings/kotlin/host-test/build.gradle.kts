// JVM host test for the generated uniffi Kotlin bindings.
//
// It compiles the exact same generated source the `brookmd` Android library ships
// (pulled in as an extra srcDir, no copy) and drives it through JNA against the
// host `libbrook_md_ffi.so`, asserting byte-equality with the wire goldens.
//
// Run: gradle -p host-test test -Djna.library.path=/path/to/dir/with/.so
plugins {
    kotlin("jvm") version "2.0.21"
}

kotlin {
    jvmToolchain(17)
}

sourceSets {
    // Compile the committed, generated bindings from the sibling Android module.
    // A srcDir reference (not a copy) guarantees the two builds test identical code.
    main {
        kotlin.srcDir("../brookmd/src/main/kotlin")
    }
}

dependencies {
    // Plain JNA jar on the JVM host (NOT the @aar classifier, which is Android-only).
    // uniffi's generated code does `Native.register(..., "brook_md_ffi")`, honoring
    // `-Djna.library.path` to locate the native library.
    implementation("net.java.dev.jna:jna:5.14.0")
    // kotlin-test mapped onto JUnit 4 (pulls junit:junit transitively); JUnit 4
    // keeps the test runnable across a wide range of the runner's Gradle versions.
    testImplementation(kotlin("test-junit"))
}

tasks.test {
    useJUnit()
    // Forward the native library location from the Gradle invocation (`-Djna.library.path=…`)
    // into the forked test JVM, where JNA actually loads the library.
    System.getProperty("jna.library.path")?.let { systemProperty("jna.library.path", it) }
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = true
    }
}
