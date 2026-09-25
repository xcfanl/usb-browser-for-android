# Native part of the usb-storage plugin: exFAT (relan/exfat 1.4.0) and NTFS (ntfs-3g
# 2022.10.3) read/write + mkfs, on top of a USB block device provided through JNI.
# Built by Gradle (externalNativeBuild) for Android and directly with CMake for host tests.
cmake_minimum_required(VERSION 3.18)
project(usbfs C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_EXTENSIONS ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
# only the JNI entry points (JNIEXPORT) are exported from libusbfs.so
set(CMAKE_C_VISIBILITY_PRESET hidden)

set(TP ${CMAKE_CURRENT_SOURCE_DIR}/third_party)
set(WARN_OFF -Wno-unused-parameter -Wno-unused-function -Wno-sign-compare
    -Wno-pointer-sign -Wno-unused-variable -Wno-unused-but-set-variable
    -Wno-format-truncation -Wno-unknown-warning-option -Wno-deprecated-declarations
    -Wno-incompatible-pointer-types-discards-qualifiers -Wno-missing-field-initializers -Wno-address-of-packed-member)

# ---- exFAT: libexfat + mkexfatfs ----
file(GLOB EXFAT_LIB ${TP}/exfat/libexfat/*.c)
add_library(usbfs_exfat STATIC
    ${EXFAT_LIB}
    ${TP}/exfat/mkfs/cbm.c ${TP}/exfat/mkfs/fat.c ${TP}/exfat/mkfs/mkexfat.c
    ${TP}/exfat/mkfs/rootdir.c ${TP}/exfat/mkfs/uct.c ${TP}/exfat/mkfs/uctc.c
    ${TP}/exfat/mkfs/vbr.c
    exfat_io.c fs_exfat.c mkfs_exfat.c)
target_include_directories(usbfs_exfat PRIVATE
    config/exfat ${TP}/exfat/libexfat ${TP}/exfat/mkfs ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_definitions(usbfs_exfat PRIVATE USBFS_CUSTOM_IO _FILE_OFFSET_BITS=64
    PACKAGE="exfat" VERSION="1.4.0"
    _GNU_SOURCE)
target_compile_options(usbfs_exfat PRIVATE ${WARN_OFF})

# ---- NTFS: libntfs-3g + mkntfs ----
file(GLOB NTFS_LIB ${TP}/ntfs-3g/libntfs-3g/*.c)
add_library(usbfs_ntfs STATIC
    ${NTFS_LIB}
    ${TP}/ntfs-3g/ntfsprogs/utils.c ${TP}/ntfs-3g/ntfsprogs/attrdef.c
    ${TP}/ntfs-3g/ntfsprogs/boot.c ${TP}/ntfs-3g/ntfsprogs/sd.c
    ntfs_io.c fs_ntfs.c mkfs_ntfs.c)
target_include_directories(usbfs_ntfs PRIVATE
    config/ntfs ${TP}/ntfs-3g/include/ntfs-3g ${TP}/ntfs-3g/ntfsprogs
    ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_definitions(usbfs_ntfs PRIVATE HAVE_CONFIG_H _FILE_OFFSET_BITS=64
    _GNU_SOURCE)
target_compile_options(usbfs_ntfs PRIVATE ${WARN_OFF})

# ---- JNI library ----
add_library(usbfs SHARED usbfs_jni.c usbfs_fs.c)
target_link_libraries(usbfs PRIVATE usbfs_exfat usbfs_ntfs)
if(ANDROID)
  find_library(log-lib log)
  target_link_libraries(usbfs PRIVATE ${log-lib})
  # 16 KB page size devices (Android 15+)
  target_link_options(usbfs PRIVATE "-Wl,-z,max-page-size=16384")
  # the app module does not always strip libraries of dependencies: strip at link time
  if(NOT CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_link_options(usbfs PRIVATE "-Wl,--strip-all")
  endif()
else()
  find_package(JNI REQUIRED)
  target_include_directories(usbfs PRIVATE ${JNI_INCLUDE_DIRS})
endif()
target_link_options(usbfs PRIVATE "-Wl,--no-undefined")
