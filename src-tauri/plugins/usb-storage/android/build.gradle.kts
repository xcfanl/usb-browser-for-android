plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.usbfile.usbstorage"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    // Apache-2.0: USB mass-storage (SCSI bulk-only) driver, MBR/GPT parsing, FAT32 read/write
    implementation("me.jahnen.libaums:core:0.10.0")
    // LGPL-2.1: JNode based file systems (exFAT, NTFS, ext2/3/4, FAT12/16, HFS+), used read-only
    implementation("me.jahnen:java-fs:0.1.4")
    implementation(project(":tauri-android"))
    testImplementation("junit:junit:4.13.2")
}

tasks.withType<Test>().configureEach {
    // disk images from scripts/make-test-images.sh; tests are skipped when unset
    System.getenv("USBFS_IMAGES")?.let { environment("USBFS_IMAGES", it) }
    maxHeapSize = "1g"
    // java-fs uses java.security.acl (present on Android, removed from desktop JDK 14+):
    // point USBFS_TEST_JAVA at a JDK/JRE 11 "java" binary to run the ext/NTFS tests.
    System.getenv("USBFS_TEST_JAVA")?.let { executable = it }
}
