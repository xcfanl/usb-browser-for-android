/* File-system dispatch for the usb-storage plugin. All functions return 0 or -errno.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef USBFS_FS_H
#define USBFS_FS_H
#include <stdint.h>
#include <stddef.h>

#define USBFS_EXFAT 1
#define USBFS_NTFS 2

struct usbfs;
typedef int (*usbfs_entry_cb)(void *ctx, const char *name, int is_dir, int64_t size,
		int64_t mtime_ms);

void usbfs_fs_init(void);
int usbfs_mount(int type, int slot, int ro, struct usbfs **out);
int usbfs_unmount(struct usbfs *fs);
int usbfs_is_ro(struct usbfs *fs);
const char *usbfs_ro_reason(struct usbfs *fs);
void usbfs_label(struct usbfs *fs, char *buf, size_t len);
void usbfs_space(struct usbfs *fs, int64_t *total, int64_t *free_);
int usbfs_list(struct usbfs *fs, const char *path, usbfs_entry_cb cb, void *ctx);
int usbfs_stat(struct usbfs *fs, const char *path, usbfs_entry_cb cb, void *ctx);
int usbfs_read(struct usbfs *fs, const char *path, int64_t off, void *buf, int64_t len,
		int64_t *got);
int usbfs_open_write(struct usbfs *fs, const char *path, void **fh); /* create/truncate */
int usbfs_write(struct usbfs *fs, void *fh, int64_t off, const void *buf, int64_t len);
int usbfs_close_write(struct usbfs *fs, void *fh);
int usbfs_mkdir(struct usbfs *fs, const char *path);
int usbfs_remove(struct usbfs *fs, const char *path); /* file or empty directory */
int usbfs_rename(struct usbfs *fs, const char *from, const char *to);
int usbfs_sync(struct usbfs *fs);
int usbfs_mkexfat(int slot, const char *label);
int usbfs_mkntfs(int slot, const char *label);

/* per-backend implementations */
struct usbfs_ops {
	int (*unmount)(struct usbfs *fs);
	void (*label)(struct usbfs *fs, char *buf, size_t len);
	void (*space)(struct usbfs *fs, int64_t *total, int64_t *free_);
	int (*list)(struct usbfs *fs, const char *path, usbfs_entry_cb cb, void *ctx);
	int (*stat)(struct usbfs *fs, const char *path, usbfs_entry_cb cb, void *ctx);
	int (*read)(struct usbfs *fs, const char *path, int64_t off, void *buf, int64_t len,
			int64_t *got);
	int (*open_write)(struct usbfs *fs, const char *path, void **fh);
	int (*write)(struct usbfs *fs, void *fh, int64_t off, const void *buf, int64_t len);
	int (*close_write)(struct usbfs *fs, void *fh);
	int (*mkdir)(struct usbfs *fs, const char *path);
	int (*remove)(struct usbfs *fs, const char *path);
	int (*rename)(struct usbfs *fs, const char *from, const char *to);
	int (*sync)(struct usbfs *fs);
};

struct usbfs {
	const struct usbfs_ops *ops;
	int type;
	int slot;
	int ro;
	char ro_reason[160];
	void *impl;
};

int usbfs_exfat_mount(struct usbfs *fs, int ro);
int usbfs_ntfs_mount(struct usbfs *fs, int ro);
void usbfs_ntfs_init(void);

#endif
