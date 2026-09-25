/*
 * mkntfs (ntfs-3g ntfsprogs/mkntfs.c) as a library call on a USB block device.
 * mkntfs.c is compiled unchanged inside this translation unit: its main() is renamed and
 * invoked with a fixed argument vector; the device "usb:<slot>" is opened through
 * ntfs_device_default_io_ops (see ntfs_io.c).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "config.h"
#include "types.h"
#include "logging.h"

static int usbfs_mkntfs_log(const char *function, const char *file, int line, u32 level,
		void *data, const char *format, va_list args);
/* keep our log handler (errors are shown in the UI) instead of printing to stdout */
#define ntfs_log_set_handler(h) ntfs_log_set_handler(usbfs_mkntfs_log)
#define main mkntfs_cli_main
#include "mkntfs.c"
#undef main
#undef ntfs_log_set_handler

#include <getopt.h>
#include "usbfs.h"
#include "usbfs_fs.h"

static int usbfs_mkntfs_log(const char *function, const char *file, int line, u32 level,
		void *data, const char *format, va_list args)
{
	(void)function; (void)file; (void)line; (void)data;
	if (level & (NTFS_LOG_LEVEL_ERROR | NTFS_LOG_LEVEL_PERROR | NTFS_LOG_LEVEL_CRITICAL)) {
		va_list ac;
		va_copy(ac, args);
		usbfs_log_error(format, ac);
		va_end(ac);
	}
	return 0;
}

int usbfs_mkntfs(int slot, const char *label)
{
	char spec[32], start[32], sector[16];
	char *argv[20];
	int argc = 0;
	int rc;

	snprintf(spec, sizeof(spec), "usb:%d", slot);
	snprintf(start, sizeof(start), "%lld", (long long)usbfs_dev_part_start(slot));
	snprintf(sector, sizeof(sector), "%d", usbfs_dev_sector_size(slot));
	argv[argc++] = "mkntfs";
	argv[argc++] = "-F"; /* the "usb:N" handle is not a block device node */
	argv[argc++] = "-Q"; /* quick format: do not zero the whole volume */
	argv[argc++] = "-q";
	argv[argc++] = "-s";
	argv[argc++] = sector;
	argv[argc++] = "-p";
	argv[argc++] = start;
	argv[argc++] = "-H";
	argv[argc++] = "255";
	argv[argc++] = "-S";
	argv[argc++] = "63";
	if (label && label[0]) {
		argv[argc++] = "-L";
		argv[argc++] = (char *)label;
	}
	argv[argc++] = spec;
	argv[argc] = NULL;

	/* reset getopt state: mkntfs may run more than once per process */
#ifdef __BIONIC__
	optreset = 1;
	optind = 1;
#else
	optind = 0;
#endif
	rc = mkntfs_cli_main(argc, argv);
	/* mkntfs_cleanup() frees but does not clear this list head */
	g_allocation = NULL;
	usbfs_ntfs_init(); /* restore log levels changed by -q */
	return rc ? -EIO : 0;
}
