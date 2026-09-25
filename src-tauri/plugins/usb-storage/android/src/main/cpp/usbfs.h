/*
 * usb-storage plugin native layer: exFAT (relan/exfat) and NTFS (ntfs-3g) on top of a
 * USB mass-storage block device that lives in Kotlin (libaums), reached through JNI.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef USBFS_H
#define USBFS_H

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>

/* Block devices are named "usb:<slot>" so that unmodified library code can "open" them. */
int usbfs_spec_slot(const char *spec);
int64_t usbfs_dev_size(int slot);
int usbfs_dev_sector_size(int slot);
int64_t usbfs_dev_part_start(int slot); /* partition start sector on the whole disk */
int usbfs_dev_pread(int slot, void *buf, size_t n, int64_t off);        /* 0 or -1/errno */
int usbfs_dev_pwrite(int slot, const void *buf, size_t n, int64_t off); /* 0 or -1/errno */
int usbfs_dev_sync(int slot);

/* Last error message reported by the libraries (for the UI). */
void usbfs_clear_error(void);
void usbfs_log_error(const char *format, va_list ap);
void usbfs_set_error(const char *format, ...);
const char *usbfs_last_error(void);

#endif
