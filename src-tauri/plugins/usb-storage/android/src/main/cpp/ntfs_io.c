/*
 * ntfs-3g device operations backed by the USB block device (replaces libntfs-3g/unix_io.c).
 * libntfs-3g and mkntfs refer to "ntfs_device_default_io_ops", which device_io.h maps to
 * ntfs_device_unix_io_ops on Linux, so defining that symbol here routes all their I/O to USB.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "config.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <linux/fs.h>
#include <linux/hdreg.h>

#include "types.h"
#include "device.h"
#include "logging.h"
#include "usbfs.h"

struct usb_priv {
	int slot;
	s64 pos;
};

#define PRIV(dev) ((struct usb_priv *)(dev)->d_private)

static int usb_open(struct ntfs_device *dev, int flags)
{
	int slot;

	if (NDevOpen(dev)) {
		errno = EBUSY;
		return -1;
	}
	slot = usbfs_spec_slot(dev->d_name);
	if (slot < 0) {
		errno = ENODEV;
		return -1;
	}
	dev->d_private = calloc(1, sizeof(struct usb_priv));
	if (!dev->d_private)
		return -1;
	PRIV(dev)->slot = slot;
	if ((flags & O_RDWR) != O_RDWR)
		NDevSetReadOnly(dev);
	NDevSetBlock(dev);
	NDevSetOpen(dev);
	return 0;
}

static int usb_close(struct ntfs_device *dev)
{
	int res = 0;

	if (!NDevOpen(dev)) {
		errno = EBADF;
		return -1;
	}
	if (NDevDirty(dev) && usbfs_dev_sync(PRIV(dev)->slot))
		res = -1;
	NDevClearOpen(dev);
	free(dev->d_private);
	dev->d_private = NULL;
	return res;
}

static s64 usb_seek(struct ntfs_device *dev, s64 offset, int whence)
{
	s64 size = usbfs_dev_size(PRIV(dev)->slot);
	s64 pos;

	switch (whence) {
	case SEEK_SET: pos = offset; break;
	case SEEK_CUR: pos = PRIV(dev)->pos + offset; break;
	case SEEK_END: pos = size + offset; break;
	default: errno = EINVAL; return -1;
	}
	if (pos < 0) {
		errno = EINVAL;
		return -1;
	}
	PRIV(dev)->pos = pos;
	return pos;
}

static s64 clamp(struct ntfs_device *dev, s64 count, s64 offset)
{
	s64 size = usbfs_dev_size(PRIV(dev)->slot);
	if (offset >= size)
		return 0;
	if (count > size - offset)
		count = size - offset;
	return count;
}

static s64 usb_pread(struct ntfs_device *dev, void *buf, s64 count, s64 offset)
{
	count = clamp(dev, count, offset);
	if (count <= 0)
		return 0;
	if (usbfs_dev_pread(PRIV(dev)->slot, buf, (size_t)count, offset))
		return -1;
	return count;
}

static s64 usb_pwrite(struct ntfs_device *dev, const void *buf, s64 count, s64 offset)
{
	if (NDevReadOnly(dev)) {
		errno = EROFS;
		return -1;
	}
	if (offset + count > usbfs_dev_size(PRIV(dev)->slot)) {
		errno = ENOSPC;
		return -1;
	}
	NDevSetDirty(dev);
	if (count <= 0)
		return 0;
	if (usbfs_dev_pwrite(PRIV(dev)->slot, buf, (size_t)count, offset))
		return -1;
	return count;
}

static s64 usb_read(struct ntfs_device *dev, void *buf, s64 count)
{
	s64 r = usb_pread(dev, buf, count, PRIV(dev)->pos);
	if (r > 0)
		PRIV(dev)->pos += r;
	return r;
}

static s64 usb_write(struct ntfs_device *dev, const void *buf, s64 count)
{
	s64 r = usb_pwrite(dev, buf, count, PRIV(dev)->pos);
	if (r > 0)
		PRIV(dev)->pos += r;
	return r;
}

static int usb_sync(struct ntfs_device *dev)
{
	if (NDevReadOnly(dev))
		return 0;
	if (usbfs_dev_sync(PRIV(dev)->slot))
		return -1;
	NDevClearDirty(dev);
	return 0;
}

static int usb_stat(struct ntfs_device *dev, struct stat *buf)
{
	memset(buf, 0, sizeof(*buf));
	/* Reported as a regular "file" of the partition size: mkntfs then needs -F and takes
	 * the sector count from st_size, and never treats it as a whole-disk device. */
	buf->st_mode = S_IFREG | 0600;
	buf->st_size = usbfs_dev_size(PRIV(dev)->slot);
	buf->st_blksize = usbfs_dev_sector_size(PRIV(dev)->slot);
	buf->st_blocks = buf->st_size / 512;
	return 0;
}

static int usb_ioctl(struct ntfs_device *dev, unsigned long request, void *argp)
{
	int slot = PRIV(dev)->slot;

	switch (request) {
#ifdef BLKGETSIZE64
	case BLKGETSIZE64:
		*(u64 *)argp = (u64)usbfs_dev_size(slot);
		return 0;
#endif
#ifdef BLKGETSIZE
	case BLKGETSIZE:
		*(unsigned long *)argp = (unsigned long)(usbfs_dev_size(slot) / 512);
		return 0;
#endif
#ifdef BLKSSZGET
	case BLKSSZGET:
		*(int *)argp = usbfs_dev_sector_size(slot);
		return 0;
#endif
#ifdef HDIO_GETGEO
	case HDIO_GETGEO: {
		struct hd_geometry *g = argp;
		g->heads = 255;
		g->sectors = 63;
		g->cylinders = 0;
		g->start = (unsigned long)usbfs_dev_part_start(slot);
		return 0;
	}
#endif
	default:
		errno = ENOTTY;
		return -1;
	}
}

struct ntfs_device_operations ntfs_device_unix_io_ops = {
	.open = usb_open,
	.close = usb_close,
	.seek = usb_seek,
	.read = usb_read,
	.write = usb_write,
	.pread = usb_pread,
	.pwrite = usb_pwrite,
	.sync = usb_sync,
	.stat = usb_stat,
	.ioctl = usb_ioctl,
};
