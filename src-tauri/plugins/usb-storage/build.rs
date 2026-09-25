const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();

    // Let Android offer this app when a USB mass-storage device is attached. Selecting it
    // (optionally "always") grants the per-device USB permission without a separate dialog.
    // Inserted into <activity> of gen/android/app/src/main/AndroidManifest.xml during
    // `tauri android build/dev` (TAURI_ANDROID_PROJECT_PATH), so it survives a regenerated
    // gen/android project. The <uses-feature> lives in android/src/main/AndroidManifest.xml
    // and is merged by Gradle.
    println!("cargo:rerun-if-env-changed=TAURI_ANDROID_PROJECT_PATH");
    tauri_plugin::mobile::update_android_manifest(
        "USB STORAGE PLUGIN",
        "activity",
        // tauri-utils prefixes every line with the <activity> child indentation
        [
            r#"<intent-filter>"#,
            r#"    <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />"#,
            r#"</intent-filter>"#,
            r#"<meta-data"#,
            r#"    android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED""#,
            r#"    android:resource="@xml/usb_storage_device_filter" />"#,
        ]
        .join("\n"),
    )
    .expect("failed to update AndroidManifest.xml");
}
