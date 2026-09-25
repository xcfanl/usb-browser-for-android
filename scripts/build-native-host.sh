#!/usr/bin/env bash
# Builds libusbfs.so (exFAT/NTFS native layer of the usb-storage plugin) for the host JVM,
# for the plugin's unit tests:
#   scripts/build-native-host.sh [build-dir]
#   USBFS_NATIVE_LIB=<build-dir>/libusbfs.so USBFS_IMAGES=... ./gradlew :tauri-plugin-usb-storage:testReleaseUnitTest
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-/tmp/usbfs-host}"
cmake -S "$here/src-tauri/plugins/usb-storage/android/src/main/cpp" -B "$out" -DCMAKE_BUILD_TYPE=Debug "${@:2}"
cmake --build "$out" -j"$(nproc)"
echo "$out/libusbfs.so"
