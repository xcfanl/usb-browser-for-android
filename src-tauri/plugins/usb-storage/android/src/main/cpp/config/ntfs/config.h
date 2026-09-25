/*
 * Hand-written config for ntfs-3g 2022.10.3 (libntfs-3g + mkntfs) built inside the
 * usb-storage plugin, for Android (bionic, API 24+) and for glibc hosts (unit tests).
 * Derived from the output of ./configure --disable-ntfs-3g --disable-crypto --without-uuid
 * --without-hd --disable-plugins on Linux/glibc.
 */
#define DISABLE_PLUGINS 1
#define HAVE_ATEXIT 1
#define HAVE_BASENAME 1
#define HAVE_BYTESWAP_H 1
#define HAVE_CLOCK_GETTIME 1
#define HAVE_CTYPE_H 1
#define HAVE_DUP2 1
#define HAVE_ENDIAN_H 1
#define HAVE_ERRNO_H 1
#define HAVE_FCNTL_H 1
#define HAVE_FDATASYNC 1
#define HAVE_FFS 1
#define HAVE_GETOPT_H 1
#define HAVE_GETOPT_LONG 1
#define HAVE_GETTIMEOFDAY 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIBGEN_H 1
#define HAVE_LIMITS_H 1
#define HAVE_LINUX_FD_H 1
#define HAVE_LINUX_FS_H 1
#define HAVE_LINUX_HDREG_H 1
#define HAVE_LINUX_MAJOR_H 1
#define HAVE_LOCALE_H 1
#define HAVE_MALLOC_H 1
#define HAVE_MBRTOWC 1
#define HAVE_MBSINIT 1
#define HAVE_MEMCPY 1
#define HAVE_MEMMOVE 1
#define HAVE_MEMSET 1
#define HAVE_RANDOM 1
#define HAVE_REALPATH 1
#define HAVE_SETLOCALE 1
#define HAVE_SNPRINTF 1
#define HAVE_STDARG_H 1
#define HAVE_STDBOOL_H 1
#define HAVE_STDDEF_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRCASECMP 1
#define HAVE_STRCHR 1
#define HAVE_STRDUP 1
#define HAVE_STRERROR 1
#define HAVE_STRFTIME 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_STRNLEN 1
#define HAVE_STRSEP 1
#define HAVE_STRTOL 1
#define HAVE_STRTOUL 1
#define HAVE_STRUCT_STAT_ST_ATIM 1
#define HAVE_STRUCT_STAT_ST_BLOCKS 1
#define HAVE_STRUCT_STAT_ST_RDEV 1
#define HAVE_ST_BLOCKS 1
#define HAVE_SYSCONF 1
#define HAVE_SYSLOG_H 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_SYS_MOUNT_H 1
#define HAVE_SYS_PARAM_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_VFS_H 1
#define HAVE_TIME_H 1
#define HAVE_UNISTD_H 1
#define HAVE_UTIME 1
#define HAVE_UTIMENSAT 1
#define HAVE_UTIME_H 1
#define HAVE_UTIME_NULL 1
#define HAVE_VPRINTF 1
#define HAVE_WCHAR_H 1
#define HAVE__BOOL 1
#define MAJOR_IN_SYSMACROS 1
#define STDC_HEADERS 1
#define WORDS_LITTLEENDIAN 1
#define PACKAGE "ntfs-3g"
#define PACKAGE_NAME "ntfs-3g"
#define PACKAGE_STRING "ntfs-3g 2022.10.3"
#define PACKAGE_TARNAME "ntfs-3g"
#define PACKAGE_VERSION "2022.10.3"
#define VERSION "2022.10.3"
/* Intentionally not defined:
 *  HAVE_MNTENT_H / HAVE_GETMNTENT / HAVE_HASMNTOPT: the volume lives behind a USB
 *    handle ("usb:N"), never in /proc/mounts; hasmntopt() needs API 26.
 *  HAVE_LIBINTL_H: not in bionic.  HAVE_SETXATTR, HAVE_DAEMON, HAVE_FORK: FUSE only.
 *  HAVE_REGEX_H / HAVE_REGCOMP: unused by the files built here. */
#ifndef _FILE_OFFSET_BITS
#define _FILE_OFFSET_BITS 64
#endif
