/*
 * exFAT read/write through relan/exfat (libexfat), following fuse/main.c of that project.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "exfat.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "usbfs.h"
#include "usbfs_fs.h"

#define EF(fs) ((struct exfat *)(fs)->impl)

static int ex_sync(struct usbfs *fs)
{
	int rc = exfat_flush_nodes(EF(fs));
	if (rc == 0)
		rc = exfat_flush(EF(fs));
	if (rc == 0)
		rc = exfat_fsync(EF(fs)->dev);
	return rc;
}

static int ex_unmount(struct usbfs *fs)
{
	int rc = fs->ro ? 0 : ex_sync(fs);
	exfat_unmount(EF(fs)); /* flushes again, clears the "mounted" state, closes the device */
	free(fs->impl);
	fs->impl = NULL;
	return rc;
}

static void ex_label(struct usbfs *fs, char *buf, size_t len)
{
	snprintf(buf, len, "%s", exfat_get_label(EF(fs)));
}

static void ex_space(struct usbfs *fs, int64_t *total, int64_t *free_)
{
	struct exfat *ef = EF(fs);
	*total = (int64_t)le32_to_cpu(ef->sb->cluster_count) * CLUSTER_SIZE(*ef->sb);
	*free_ = (int64_t)exfat_count_free_clusters(ef) * CLUSTER_SIZE(*ef->sb);
}

static int emit(struct exfat *ef, struct exfat_node *node, const char *name,
		usbfs_entry_cb cb, void *ctx)
{
	(void)ef;
	int dir = (node->attrib & EXFAT_ATTRIB_DIR) != 0;
	return cb(ctx, name, dir, dir ? 0 : (int64_t)node->size, (int64_t)node->mtime * 1000);
}

static int ex_list(struct usbfs *fs, const char *path, usbfs_entry_cb cb, void *ctx)
{
	struct exfat *ef = EF(fs);
	struct exfat_node *parent, *node;
	struct exfat_iterator it;
	char name[EXFAT_UTF8_NAME_BUFFER_MAX];
	int rc = exfat_lookup(ef, &parent, path);
	if (rc)
		return rc;
	if (!(parent->attrib & EXFAT_ATTRIB_DIR)) {
		exfat_put_node(ef, parent);
		return -ENOTDIR;
	}
	rc = exfat_opendir(ef, parent, &it);
	if (rc) {
		exfat_put_node(ef, parent);
		return rc;
	}
	while ((node = exfat_readdir(&it))) {
		exfat_get_name(node, name);
		if (rc == 0)
			rc = emit(ef, node, name, cb, ctx);
		exfat_put_node(ef, node);
	}
	exfat_closedir(ef, &it);
	exfat_put_node(ef, parent);
	return rc;
}

static int ex_stat(struct usbfs *fs, const char *path, usbfs_entry_cb cb, void *ctx)
{
	struct exfat *ef = EF(fs);
	struct exfat_node *node;
	char name[EXFAT_UTF8_NAME_BUFFER_MAX];
	int rc = exfat_lookup(ef, &node, path);
	if (rc)
		return rc;
	exfat_get_name(node, name);
	rc = emit(ef, node, name, cb, ctx);
	exfat_put_node(ef, node);
	return rc;
}

static int ex_read(struct usbfs *fs, const char *path, int64_t off, void *buf, int64_t len,
		int64_t *got)
{
	struct exfat *ef = EF(fs);
	struct exfat_node *node;
	int rc = exfat_lookup(ef, &node, path);
	if (rc)
		return rc;
	if (node->attrib & EXFAT_ATTRIB_DIR) {
		exfat_put_node(ef, node);
		return -EISDIR;
	}
	ssize_t r = exfat_generic_pread(ef, node, buf, (size_t)len, (off_t)off);
	exfat_put_node(ef, node);
	if (r < 0)
		return (int)r;
	*got = r;
	return 0;
}

static int ex_open_write(struct usbfs *fs, const char *path, void **fh)
{
	struct exfat *ef = EF(fs);
	struct exfat_node *node;
	int rc = exfat_lookup(ef, &node, path);
	if (rc == -ENOENT) {
		rc = exfat_mknod(ef, path);
		if (rc)
			return rc;
		rc = exfat_lookup(ef, &node, path);
		if (rc)
			return rc;
	} else if (rc) {
		return rc;
	} else {
		if (node->attrib & EXFAT_ATTRIB_DIR) {
			exfat_put_node(ef, node);
			return -EISDIR;
		}
		rc = exfat_truncate(ef, node, 0, true);
		if (rc == 0)
			rc = exfat_flush_node(ef, node);
		if (rc) {
			exfat_put_node(ef, node);
			return rc;
		}
	}
	*fh = node;
	return 0;
}

static int ex_write(struct usbfs *fs, void *fh, int64_t off, const void *buf, int64_t len)
{
	ssize_t r = exfat_generic_pwrite(EF(fs), fh, buf, (size_t)len, (off_t)off);
	if (r < 0)
		return (int)r;
	if (r != len)
		return -ENOSPC;
	return 0;
}

static int ex_close_write(struct usbfs *fs, void *fh)
{
	int rc = exfat_flush_node(EF(fs), fh);
	exfat_put_node(EF(fs), fh);
	return rc;
}

static int ex_mkdir(struct usbfs *fs, const char *path)
{
	return exfat_mkdir(EF(fs), path);
}

static int ex_remove(struct usbfs *fs, const char *path)
{
	struct exfat *ef = EF(fs);
	struct exfat_node *node;
	int rc = exfat_lookup(ef, &node, path);
	if (rc)
		return rc;
	if (node == ef->root) {
		exfat_put_node(ef, node);
		return -EBUSY;
	}
	rc = (node->attrib & EXFAT_ATTRIB_DIR) ? exfat_rmdir(ef, node) : exfat_unlink(ef, node);
	exfat_put_node(ef, node);
	if (rc)
		return rc;
	return exfat_cleanup_node(ef, node);
}

static int ex_rename(struct usbfs *fs, const char *from, const char *to)
{
	return exfat_rename(EF(fs), from, to);
}

static const struct usbfs_ops ex_ops = {
	ex_unmount, ex_label, ex_space, ex_list, ex_stat, ex_read,
	ex_open_write, ex_write, ex_close_write, ex_mkdir, ex_remove, ex_rename, ex_sync,
};

int usbfs_exfat_mount(struct usbfs *fs, int ro)
{
	char spec[32];
	struct exfat *ef = calloc(1, sizeof(*ef));
	if (!ef)
		return -ENOMEM;
	snprintf(spec, sizeof(spec), "usb:%d", fs->slot);
	/* noatime: reading a file must never write to the drive */
	int rc = exfat_mount(ef, spec, ro ? "ro" : "noatime");
	if (rc) {
		free(ef);
		return rc;
	}
	fs->impl = ef;
	fs->ops = &ex_ops;
	fs->ro = ef->ro != 0;
	if (fs->ro && !ro)
		snprintf(fs->ro_reason, sizeof(fs->ro_reason), "%s",
				"设备写保护或 exFAT 卷不支持写入，已以只读方式打开");
	return 0;
}
