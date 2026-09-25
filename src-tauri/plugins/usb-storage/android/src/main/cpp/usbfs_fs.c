/* SPDX-License-Identifier: GPL-3.0-or-later */
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include "usbfs_fs.h"

void usbfs_fs_init(void)
{
	usbfs_ntfs_init();
}

int usbfs_mount(int type, int slot, int ro, struct usbfs **out)
{
	struct usbfs *fs = calloc(1, sizeof(*fs));
	int rc;
	if (!fs)
		return -ENOMEM;
	fs->type = type;
	fs->slot = slot;
	if (type == USBFS_EXFAT)
		rc = usbfs_exfat_mount(fs, ro);
	else if (type == USBFS_NTFS)
		rc = usbfs_ntfs_mount(fs, ro);
	else
		rc = -EINVAL;
	if (rc) {
		free(fs);
		return rc;
	}
	*out = fs;
	return 0;
}

int usbfs_unmount(struct usbfs *fs)
{
	int rc = fs->ops->unmount(fs);
	free(fs);
	return rc;
}

int usbfs_is_ro(struct usbfs *fs) { return fs->ro; }
const char *usbfs_ro_reason(struct usbfs *fs) { return fs->ro_reason; }
void usbfs_label(struct usbfs *fs, char *buf, size_t len) { fs->ops->label(fs, buf, len); }
void usbfs_space(struct usbfs *fs, int64_t *t, int64_t *f) { fs->ops->space(fs, t, f); }

int usbfs_list(struct usbfs *fs, const char *p, usbfs_entry_cb cb, void *ctx)
{
	if (!p)
		return -ENOMEM;
	return fs->ops->list(fs, p, cb, ctx);
}

int usbfs_stat(struct usbfs *fs, const char *p, usbfs_entry_cb cb, void *ctx)
{
	if (!p)
		return -ENOMEM;
	return fs->ops->stat(fs, p, cb, ctx);
}

int usbfs_read(struct usbfs *fs, const char *p, int64_t off, void *buf, int64_t len, int64_t *got)
{
	if (!p)
		return -ENOMEM;
	return fs->ops->read(fs, p, off, buf, len, got);
}

#define RW_CHECK() do { if (fs->ro) return -EROFS; } while (0)

int usbfs_open_write(struct usbfs *fs, const char *p, void **fh)
{
	if (!p)
		return -ENOMEM;
	RW_CHECK();
	return fs->ops->open_write(fs, p, fh);
}

int usbfs_write(struct usbfs *fs, void *fh, int64_t off, const void *buf, int64_t len)
{
	RW_CHECK();
	return fs->ops->write(fs, fh, off, buf, len);
}

int usbfs_close_write(struct usbfs *fs, void *fh)
{
	return fs->ops->close_write(fs, fh);
}

int usbfs_mkdir(struct usbfs *fs, const char *p)
{
	if (!p)
		return -ENOMEM;
	RW_CHECK();
	return fs->ops->mkdir(fs, p);
}

int usbfs_remove(struct usbfs *fs, const char *p)
{
	if (!p)
		return -ENOMEM;
	RW_CHECK();
	return fs->ops->remove(fs, p);
}

int usbfs_rename(struct usbfs *fs, const char *a, const char *b)
{
	if (!a || !b)
		return -ENOMEM;
	RW_CHECK();
	return fs->ops->rename(fs, a, b);
}

int usbfs_sync(struct usbfs *fs)
{
	if (fs->ro)
		return 0;
	return fs->ops->sync(fs);
}
