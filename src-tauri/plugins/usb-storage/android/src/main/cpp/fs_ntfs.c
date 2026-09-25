/*
 * NTFS read/write through ntfs-3g (libntfs-3g), following src/ntfs-3g.c of that project
 * (create, link/unlink based rename, delete, attribute I/O).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "config.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "types.h"
#include "attrib.h"
#include "inode.h"
#include "dir.h"
#include "volume.h"
#include "unistr.h"
#include "logging.h"
#include "ntfstime.h"
#include "misc.h"

#include "usbfs.h"
#include "usbfs_fs.h"

#define VOL(fs) ((ntfs_volume *)(fs)->impl)

static int log_handler(const char *function, const char *file, int line, u32 level,
		void *data, const char *format, va_list args)
{
	(void)function; (void)file; (void)line; (void)data;
	if (level & (NTFS_LOG_LEVEL_ERROR | NTFS_LOG_LEVEL_PERROR | NTFS_LOG_LEVEL_CRITICAL)) {
		va_list ac;
		va_copy(ac, args);
		usbfs_log_error(format, ac);
		va_end(ac);
	}
#ifdef __ANDROID__
	return 0;
#else
	return 0;
#endif
}

void usbfs_ntfs_init(void)
{
	ntfs_log_set_handler(log_handler);
	ntfs_log_set_levels(NTFS_LOG_LEVEL_ERROR | NTFS_LOG_LEVEL_PERROR |
			NTFS_LOG_LEVEL_CRITICAL | NTFS_LOG_LEVEL_WARNING);
}

static int err(void)
{
	return errno ? -errno : -EIO;
}

/* Splits "/a/b/c" into a malloc'ed parent ("/a/b") and a pointer to the last name ("c"). */
static int split(const char *path, char **parent, const char **name)
{
	char *p = strdup(path);
	if (!p)
		return -ENOMEM;
	char *slash = strrchr(p, '/');
	if (!slash || !slash[1]) {
		free(p);
		return -EINVAL;
	}
	*name = path + (slash - p) + 1;
	if (slash == p)
		slash[1] = 0; /* parent is the root */
	else
		*slash = 0;
	*parent = p;
	return 0;
}

static int to_uname(ntfs_volume *vol, const char *name, ntfschar **uname)
{
	int len = ntfs_mbstoucs(name, uname);
	if (len < 0)
		return err();
	/* keep names usable from Windows (same as the ntfs-3g "windows_names" option) */
	if (ntfs_forbidden_names(vol, *uname, len, TRUE)) {
		free(*uname);
		*uname = NULL;
		usbfs_set_error("NTFS 不允许的文件名（不能包含 \\ / : * ? \" < > | 或使用保留名）");
		return -EINVAL;
	}
	return len;
}

static int64_t mtime_ms(ntfs_inode *ni)
{
	struct timespec ts = ntfs2timespec(ni->last_data_change_time);
	return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int is_dir(ntfs_inode *ni)
{
	return (ni->mrec->flags & MFT_RECORD_IS_DIRECTORY) != 0;
}

static int64_t data_size(ntfs_inode *ni)
{
	int64_t size = 0;
	ntfs_attr *na = ntfs_attr_open(ni, AT_DATA, AT_UNNAMED, 0);
	if (na) {
		size = na->data_size;
		ntfs_attr_close(na);
	}
	return size;
}

static int emit_inode(ntfs_inode *ni, const char *name, usbfs_entry_cb cb, void *ctx)
{
	int dir = is_dir(ni);
	return cb(ctx, name, dir, dir ? 0 : data_size(ni), mtime_ms(ni));
}

/* ---------- mount ---------- */

static int nt_unmount(struct usbfs *fs)
{
	/* writes back inodes, clears the volume dirty flag, syncs and closes the device */
	int rc = ntfs_umount(VOL(fs), FALSE) ? err() : 0;
	fs->impl = NULL;
	return rc;
}

static void nt_label(struct usbfs *fs, char *buf, size_t len)
{
	snprintf(buf, len, "%s", VOL(fs)->vol_name ? VOL(fs)->vol_name : "");
}

static void nt_space(struct usbfs *fs, int64_t *total, int64_t *free_)
{
	ntfs_volume *vol = VOL(fs);
	*total = (int64_t)vol->nr_clusters * vol->cluster_size;
	*free_ = vol->free_clusters > 0 ? (int64_t)vol->free_clusters * vol->cluster_size : 0;
}

/* ---------- listing ---------- */

struct dent {
	char *name;
	MFT_REF mref;
};

struct dlist {
	struct dent *v;
	int n, cap;
};

static int filler(void *p, const ntfschar *name, const int name_len, const int name_type,
		const s64 pos, const MFT_REF mref, const unsigned dt_type)
{
	(void)pos; (void)dt_type;
	struct dlist *l = p;
	char *s = NULL;
	if (name_type == FILE_NAME_DOS)
		return 0;
	if (MREF(mref) < FILE_first_user && MREF(mref) != FILE_root)
		return 0; /* $MFT, $Bitmap, ... */
	if (ntfs_ucstombs(name, name_len, &s, 0) < 0)
		return 0; /* undecodable name: skip, like ntfs-3g does */
	if (!strcmp(s, ".") || !strcmp(s, "..")) {
		free(s);
		return 0;
	}
	if (l->n == l->cap) {
		int ncap = l->cap ? l->cap * 2 : 64;
		struct dent *nv = realloc(l->v, ncap * sizeof(*nv));
		if (!nv) {
			free(s);
			return -1;
		}
		l->v = nv;
		l->cap = ncap;
	}
	l->v[l->n].name = s;
	l->v[l->n].mref = mref;
	l->n++;
	return 0;
}

static int nt_list(struct usbfs *fs, const char *path, usbfs_entry_cb cb, void *ctx)
{
	ntfs_volume *vol = VOL(fs);
	struct dlist l = { NULL, 0, 0 };
	s64 pos = 0;
	int rc = 0;
	ntfs_inode *dir = ntfs_pathname_to_inode(vol, NULL, path);
	if (!dir)
		return err();
	if (!is_dir(dir)) {
		ntfs_inode_close(dir);
		return -ENOTDIR;
	}
	if (ntfs_readdir(dir, &pos, &l, filler))
		rc = err();
	ntfs_inode_close(dir);
	for (int i = 0; i < l.n; i++) {
		if (rc == 0) {
			ntfs_inode *ni = ntfs_inode_open(vol, MREF(l.v[i].mref));
			if (ni) {
				/* hide NTFS metadata that lives in the root ($Extend is < first_user) */
				rc = emit_inode(ni, l.v[i].name, cb, ctx);
				ntfs_inode_close(ni);
			}
		}
		free(l.v[i].name);
	}
	free(l.v);
	return rc;
}

static int nt_stat(struct usbfs *fs, const char *path, usbfs_entry_cb cb, void *ctx)
{
	ntfs_inode *ni = ntfs_pathname_to_inode(VOL(fs), NULL, path);
	if (!ni)
		return err();
	const char *name = strrchr(path, '/');
	int rc = emit_inode(ni, name ? name + 1 : path, cb, ctx);
	ntfs_inode_close(ni);
	return rc;
}

/* ---------- file data ---------- */

static int nt_read(struct usbfs *fs, const char *path, int64_t off, void *buf, int64_t len,
		int64_t *got)
{
	int rc = 0;
	int64_t done = 0;
	ntfs_inode *ni = ntfs_pathname_to_inode(VOL(fs), NULL, path);
	if (!ni)
		return err();
	if (is_dir(ni)) {
		ntfs_inode_close(ni);
		return -EISDIR;
	}
	ntfs_attr *na = ntfs_attr_open(ni, AT_DATA, AT_UNNAMED, 0);
	if (!na) {
		rc = err();
		ntfs_inode_close(ni);
		return rc;
	}
	if (off < na->data_size) {
		if (len > na->data_size - off)
			len = na->data_size - off;
		while (done < len) {
			s64 r = ntfs_attr_pread(na, off + done, len - done, (char *)buf + done);
			if (r < 0) {
				rc = err();
				break;
			}
			if (r == 0)
				break;
			done += r;
		}
	}
	ntfs_attr_close(na);
	ntfs_inode_close(ni);
	*got = done;
	return rc;
}

struct nfh {
	ntfs_inode *ni;
	ntfs_attr *na;
};

static int nt_open_write(struct usbfs *fs, const char *path, void **out)
{
	ntfs_volume *vol = VOL(fs);
	ntfs_inode *ni = ntfs_pathname_to_inode(vol, NULL, path);
	int rc;

	if (ni) {
		if (is_dir(ni)) {
			ntfs_inode_close(ni);
			return -EISDIR;
		}
		if (ni->mft_no < FILE_first_user) {
			ntfs_inode_close(ni);
			return -EPERM;
		}
	} else {
		char *parent;
		const char *name;
		ntfschar *uname = NULL;
		if (errno != ENOENT)
			return err();
		if ((rc = split(path, &parent, &name)))
			return rc;
		int ulen = to_uname(vol, name, &uname);
		if (ulen < 0) {
			free(parent);
			return ulen;
		}
		ntfs_inode *dir = ntfs_pathname_to_inode(vol, NULL, parent);
		free(parent);
		if (!dir) {
			free(uname);
			return err();
		}
		ni = ntfs_create(dir, const_cpu_to_le32(0), uname, ulen, S_IFREG);
		rc = ni ? 0 : err();
		free(uname);
		if (ni) {
			ni->flags |= FILE_ATTR_ARCHIVE;
			NInoSetDirty(ni);
			ntfs_inode_update_times(dir, NTFS_UPDATE_MCTIME);
		}
		/* close the directory first so the new name is in its index on disk */
		if (ntfs_inode_close(dir) && !rc)
			rc = err();
		if (rc) {
			if (ni)
				ntfs_inode_close(ni);
			return rc;
		}
	}
	ntfs_attr *na = ntfs_attr_open(ni, AT_DATA, AT_UNNAMED, 0);
	if (!na) {
		rc = err();
		ntfs_inode_close(ni);
		return rc;
	}
	if (na->data_size && ntfs_attr_truncate(na, 0)) {
		rc = err();
		ntfs_attr_close(na);
		ntfs_inode_close(ni);
		return rc;
	}
	struct nfh *h = calloc(1, sizeof(*h));
	if (!h) {
		ntfs_attr_close(na);
		ntfs_inode_close(ni);
		return -ENOMEM;
	}
	h->ni = ni;
	h->na = na;
	*out = h;
	return 0;
}

static int nt_write(struct usbfs *fs, void *fh, int64_t off, const void *buf, int64_t len)
{
	(void)fs;
	struct nfh *h = fh;
	int64_t done = 0;
	while (done < len) {
		s64 r = ntfs_attr_pwrite(h->na, off + done, len - done, (const char *)buf + done);
		if (r <= 0)
			return r < 0 ? err() : -ENOSPC;
		done += r;
	}
	return 0;
}

static int nt_close_write(struct usbfs *fs, void *fh)
{
	(void)fs;
	struct nfh *h = fh;
	int rc = 0;
	ntfs_attr_close(h->na);
	ntfs_inode_update_times(h->ni, NTFS_UPDATE_MCTIME);
	h->ni->flags |= FILE_ATTR_ARCHIVE;
	NInoSetDirty(h->ni);
	if (ntfs_inode_close(h->ni)) /* writes the MFT record and the size in the index */
		rc = err();
	free(h);
	return rc;
}

/* ---------- namespace ---------- */

static int nt_mkdir(struct usbfs *fs, const char *path)
{
	ntfs_volume *vol = VOL(fs);
	char *parent;
	const char *name;
	ntfschar *uname = NULL;
	int rc;

	ntfs_inode *ex = ntfs_pathname_to_inode(vol, NULL, path);
	if (ex) {
		ntfs_inode_close(ex);
		return -EEXIST;
	}
	if ((rc = split(path, &parent, &name)))
		return rc;
	int ulen = to_uname(vol, name, &uname);
	if (ulen < 0) {
		free(parent);
		return ulen;
	}
	ntfs_inode *dir = ntfs_pathname_to_inode(vol, NULL, parent);
	free(parent);
	if (!dir) {
		free(uname);
		return err();
	}
	ntfs_inode *ni = ntfs_create(dir, const_cpu_to_le32(0), uname, ulen, S_IFDIR);
	rc = ni ? 0 : err();
	free(uname);
	if (ni) {
		NInoSetDirty(ni);
		if (ntfs_inode_close_in_dir(ni, dir))
			rc = err();
		ntfs_inode_update_times(dir, NTFS_UPDATE_MCTIME);
	}
	if (ntfs_inode_close(dir) && !rc)
		rc = err();
	return rc;
}

/* ntfs_fuse_link() */
static int nt_link(ntfs_volume *vol, const char *old_path, const char *new_path)
{
	char *parent;
	const char *name;
	ntfschar *uname = NULL;
	int rc;

	if ((rc = split(new_path, &parent, &name)))
		return rc;
	ntfs_inode *ni = ntfs_pathname_to_inode(vol, NULL, old_path);
	if (!ni) {
		free(parent);
		return err();
	}
	int ulen = to_uname(vol, name, &uname);
	if (ulen < 0) {
		free(parent);
		ntfs_inode_close(ni);
		return ulen;
	}
	ntfs_inode *dir = ntfs_pathname_to_inode(vol, NULL, parent);
	free(parent);
	if (!dir) {
		rc = err();
	} else if (ntfs_link(ni, dir, uname, ulen)) {
		rc = err();
	} else {
		ntfs_inode_update_times(ni, NTFS_UPDATE_CTIME);
		ntfs_inode_update_times(dir, NTFS_UPDATE_MCTIME);
	}
	free(uname);
	/* close dir first, see ntfs-3g's ntfs_fuse_link() */
	if (dir && ntfs_inode_close(dir) && !rc)
		rc = err();
	if (ntfs_inode_close(ni) && !rc)
		rc = err();
	return rc;
}

/* ntfs_fuse_rm(): unlink one name; deletes the inode with its last name */
static int nt_unlink(ntfs_volume *vol, const char *path)
{
	char *parent;
	const char *name;
	ntfschar *uname = NULL;
	int rc;

	ntfs_inode *ni = ntfs_pathname_to_inode(vol, NULL, path);
	if (!ni)
		return err();
	if (ni->mft_no < FILE_first_user) {
		ntfs_inode_close(ni);
		return -EPERM;
	}
	if ((rc = split(path, &parent, &name))) {
		ntfs_inode_close(ni);
		return rc;
	}
	int ulen = ntfs_mbstoucs(name, &uname);
	if (ulen < 0) {
		rc = err();
		free(parent);
		ntfs_inode_close(ni);
		return rc;
	}
	ntfs_inode *dir = ntfs_pathname_to_inode(vol, NULL, parent);
	free(parent);
	if (!dir || dir->mft_no == FILE_Extend) {
		rc = dir ? -EPERM : err();
		if (dir)
			ntfs_inode_close(dir);
		ntfs_inode_close(ni);
		free(uname);
		return rc;
	}
	/* ntfs_delete() always closes ni and dir */
	if (ntfs_delete(vol, path, ni, dir, uname, ulen))
		rc = err();
	free(uname);
	return rc;
}

static int nt_remove(struct usbfs *fs, const char *path)
{
	if (!strcmp(path, "/") || !path[0])
		return -EBUSY;
	return nt_unlink(VOL(fs), path);
}

static int nt_rename(struct usbfs *fs, const char *from, const char *to)
{
	ntfs_volume *vol = VOL(fs);
	int rc;
	ntfs_inode *src = ntfs_pathname_to_inode(vol, NULL, from);
	if (!src)
		return err();
	u64 src_no = src->mft_no;
	ntfs_inode_close(src);

	ntfs_inode *dst = ntfs_pathname_to_inode(vol, NULL, to);
	if (dst) {
		u64 dst_no = dst->mft_no;
		ntfs_inode_close(dst);
		if (dst_no != src_no)
			return -EEXIST;
		/* same inode: a case-only change ("a.txt" -> "A.txt"), go through a temp name */
		char *tmp = malloc(strlen(to) + 32);
		if (!tmp)
			return -ENOMEM;
		sprintf(tmp, "%s.usbrename-%u", to, (unsigned)rand());
		rc = nt_link(vol, from, tmp);
		if (!rc && !(rc = nt_unlink(vol, from))) {
			rc = nt_link(vol, tmp, to);
			if (rc)
				nt_link(vol, tmp, from); /* restore */
			nt_unlink(vol, tmp);
		} else if (rc == 0) {
			nt_unlink(vol, tmp);
		}
		free(tmp);
		return rc;
	}
	if (errno != ENOENT)
		return err();
	rc = nt_link(vol, from, to);
	if (rc)
		return rc;
	rc = nt_unlink(vol, from);
	if (rc)
		nt_unlink(vol, to);
	return rc;
}

static int nt_sync(struct usbfs *fs)
{
	/* inodes are closed after every operation, so metadata is already written;
	   make the drive commit its cache */
	ntfs_volume *vol = VOL(fs);
	if (vol->dev->d_ops->sync(vol->dev))
		return err();
	return 0;
}

static const struct usbfs_ops nt_ops = {
	nt_unmount, nt_label, nt_space, nt_list, nt_stat, nt_read,
	nt_open_write, nt_write, nt_close_write, nt_mkdir, nt_remove, nt_rename, nt_sync,
};

int usbfs_ntfs_mount(struct usbfs *fs, int ro)
{
	char spec[32];
	snprintf(spec, sizeof(spec), "usb:%d", fs->slot);
	/* MAY_RDONLY: hibernated / fast-startup Windows volumes are opened read-only instead of
	   failing; RECOVER: reset an unclean $LogFile like ntfs-3g does by default */
	unsigned long flags = ro ? NTFS_MNT_RDONLY : (NTFS_MNT_MAY_RDONLY | NTFS_MNT_RECOVER);
	errno = 0;
	ntfs_volume *vol = ntfs_mount(spec, flags);
	if (!vol)
		return err();
	NVolClearCompression(vol);
	if (ntfs_set_shown_files(vol, FALSE, TRUE, FALSE) || ntfs_volume_get_free_space(vol)) {
		int rc = err();
		ntfs_umount(vol, FALSE);
		return rc;
	}
	fs->impl = vol;
	fs->ops = &nt_ops;
	fs->ro = NVolReadOnly(vol) ? 1 : 0;
	if (fs->ro && !ro)
		snprintf(fs->ro_reason, sizeof(fs->ro_reason), "%s",
				"Windows 未正常关闭此卷（休眠或“快速启动”），为保护数据已以只读方式打开");
	return 0;
}
