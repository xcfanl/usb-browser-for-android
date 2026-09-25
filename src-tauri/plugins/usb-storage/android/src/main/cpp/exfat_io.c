/*
 * relan/exfat block device layer backed by the USB block device (replaces the device part
 * of libexfat/io.c, see USBFS_CUSTOM_IO there). Used by both libexfat and mkexfatfs.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "exfat.h"
#include <errno.h>
#include <stdlib.h>
#include "usbfs.h"

struct exfat_dev {
	int slot;
	enum exfat_mode mode;
	off_t size;
	off_t pos;
};

struct exfat_dev *exfat_open(const char *spec, enum exfat_mode mode)
{
	struct exfat_dev *dev;
	int slot = usbfs_spec_slot(spec);

	if (slot < 0) {
		exfat_error("unsupported device '%s'", spec);
		return NULL;
	}
	dev = calloc(1, sizeof(*dev));
	if (!dev) {
		exfat_error("failed to allocate memory for device structure");
		return NULL;
	}
	dev->slot = slot;
	/* EXFAT_MODE_ANY is resolved to read-write: the USB handle is always writable
	   (read-only mounts pass EXFAT_MODE_RO explicitly). */
	dev->mode = mode == EXFAT_MODE_ANY ? EXFAT_MODE_RW : mode;
	dev->size = usbfs_dev_size(slot);
	if (dev->size <= 0) {
		free(dev);
		exfat_error("failed to get size of '%s'", spec);
		return NULL;
	}
	return dev;
}

int exfat_close(struct exfat_dev *dev)
{
	int rc = exfat_fsync(dev);
	free(dev);
	return rc;
}

int exfat_fsync(struct exfat_dev *dev)
{
	if (dev->mode == EXFAT_MODE_RO)
		return 0;
	if (usbfs_dev_sync(dev->slot) != 0) {
		exfat_error("fsync failed");
		return -EIO;
	}
	return 0;
}

enum exfat_mode exfat_get_mode(const struct exfat_dev *dev)
{
	return dev->mode;
}

off_t exfat_get_size(const struct exfat_dev *dev)
{
	return dev->size;
}

off_t exfat_seek(struct exfat_dev *dev, off_t offset, int whence)
{
	off_t pos;
	switch (whence) {
	case SEEK_SET: pos = offset; break;
	case SEEK_CUR: pos = dev->pos + offset; break;
	case SEEK_END: pos = dev->size + offset; break;
	default: errno = EINVAL; return (off_t)-1;
	}
	if (pos < 0) {
		errno = EINVAL;
		return (off_t)-1;
	}
	dev->pos = pos;
	return pos;
}

ssize_t exfat_pread(struct exfat_dev *dev, void *buffer, size_t size, off_t offset)
{
	if (offset < 0 || offset >= dev->size)
		return 0;
	if ((off_t)size > dev->size - offset)
		size = (size_t)(dev->size - offset);
	if (usbfs_dev_pread(dev->slot, buffer, size, offset) != 0)
		return -1;
	return (ssize_t)size;
}

ssize_t exfat_pwrite(struct exfat_dev *dev, const void *buffer, size_t size, off_t offset)
{
	if (dev->mode == EXFAT_MODE_RO) {
		errno = EROFS;
		return -1;
	}
	if (offset < 0 || offset + (off_t)size > dev->size) {
		errno = ENOSPC;
		return -1;
	}
	if (usbfs_dev_pwrite(dev->slot, buffer, size, offset) != 0)
		return -1;
	return (ssize_t)size;
}

ssize_t exfat_read(struct exfat_dev *dev, void *buffer, size_t size)
{
	ssize_t r = exfat_pread(dev, buffer, size, dev->pos);
	if (r > 0)
		dev->pos += r;
	return r;
}

ssize_t exfat_write(struct exfat_dev *dev, const void *buffer, size_t size)
{
	ssize_t r = exfat_pwrite(dev, buffer, size, dev->pos);
	if (r > 0)
		dev->pos += r;
	return r;
}
