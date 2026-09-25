/*
 * mkexfatfs (relan/exfat mkfs/main.c) as a library call on a USB block device.
 * main.c is compiled unchanged inside this translation unit so that its static setup()
 * can be called directly.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#define main mkexfat_cli_main
#include "main.c"
#undef main

#include <errno.h>
#include "usbfs.h"
#include "usbfs_fs.h"

int usbfs_mkexfat(int slot, const char *label)
{
	char spec[32];
	int sector_bits = 9;
	struct exfat_dev *dev;
	int rc;

	for (int s = usbfs_dev_sector_size(slot); s > 512 && sector_bits < 12; s >>= 1)
		sector_bits++;
	snprintf(spec, sizeof(spec), "usb:%d", slot);
	dev = exfat_open(spec, EXFAT_MODE_RW);
	if (dev == NULL)
		return -ENODEV;
	/* spc_bits -1: default cluster size for the volume size; serial 0: generated;
	   first_sector: partition offset recorded in the boot sector */
	rc = setup(dev, sector_bits, -1, label && label[0] ? label : NULL, 0,
			(uint64_t)usbfs_dev_part_start(slot));
	if (exfat_close(dev) != 0 && rc == 0)
		rc = 1;
	return rc ? -EIO : 0;
}
