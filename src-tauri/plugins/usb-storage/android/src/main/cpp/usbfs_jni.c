/*
 * JNI bridge of the usb-storage plugin.
 *
 *  - Block devices: Kotlin NativeBlockDevice objects (libaums SCSI over USB, or a file in
 *    host unit tests) are registered in slots; C code reaches them as "usb:<slot>".
 *  - File systems: exFAT through relan/exfat (libexfat) and NTFS through ntfs-3g
 *    (libntfs-3g), both read-write; mkfs through mkexfatfs and mkntfs.
 *
 * All calls come from one Kotlin worker thread (the plugin's single-thread executor);
 * neither library is thread safe.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include <jni.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "usbfs.h"
#include "usbfs_fs.h"

#ifdef __ANDROID__
#include <android/log.h>
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "UsbStorageNative", __VA_ARGS__)
#else
#define LOGE(...) (fprintf(stderr, "UsbStorageNative: " __VA_ARGS__), fputc('\n', stderr))
#endif

#define MAX_SLOTS 8
#define CHUNK (1024 * 1024)

struct slot {
	jobject obj;          /* global ref to NativeBlockDevice */
	int64_t size;         /* bytes */
	int sector_size;
	int64_t part_start;   /* sector */
};

static JavaVM *g_vm;
static struct slot g_slots[MAX_SLOTS];
static jbyteArray g_buf; /* global ref, CHUNK bytes, single-threaded use */
static jmethodID m_read, m_write, m_sync;
static char g_err[512];

/* ---------- errors ---------- */

void usbfs_clear_error(void) { g_err[0] = 0; }
const char *usbfs_last_error(void) { return g_err; }

void usbfs_log_error(const char *format, va_list ap)
{
	vsnprintf(g_err, sizeof(g_err), format, ap);
	size_t n = strlen(g_err);
	while (n && (g_err[n - 1] == '\n' || g_err[n - 1] == '.'))
		g_err[--n] = 0;
}

void usbfs_set_error(const char *format, ...)
{
	va_list ap;
	va_start(ap, format);
	usbfs_log_error(format, ap);
	va_end(ap);
}

static JNIEnv *env_get(void)
{
	JNIEnv *env = NULL;
	if ((*g_vm)->GetEnv(g_vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK)
		return NULL;
	return env;
}

static void throw_io(JNIEnv *env, const char *what, int err)
{
	char msg[768];
	const char *detail = g_err[0] ? g_err : "";
	if (err < 0)
		err = -err;
	if (err)
		snprintf(msg, sizeof(msg), "%s: %s%s%s", what, strerror(err),
				detail[0] ? " - " : "", detail);
	else
		snprintf(msg, sizeof(msg), "%s%s%s", what, detail[0] ? ": " : "", detail);
	jclass cls = (*env)->FindClass(env, "java/io/IOException");
	if (cls)
		(*env)->ThrowNew(env, cls, msg);
}

/* ---------- block devices ---------- */

int usbfs_spec_slot(const char *spec)
{
	int slot;
	if (!spec || strncmp(spec, "usb:", 4) != 0)
		return -1;
	slot = atoi(spec + 4);
	if (slot < 0 || slot >= MAX_SLOTS || !g_slots[slot].obj)
		return -1;
	return slot;
}

int64_t usbfs_dev_size(int slot) { return g_slots[slot].size; }
int usbfs_dev_sector_size(int slot) { return g_slots[slot].sector_size; }
int64_t usbfs_dev_part_start(int slot) { return g_slots[slot].part_start; }

static int java_failed(JNIEnv *env, const char *op)
{
	if (!(*env)->ExceptionCheck(env))
		return 0;
	jthrowable ex = (*env)->ExceptionOccurred(env);
	(*env)->ExceptionClear(env);
	jclass cls = (*env)->GetObjectClass(env, ex);
	jmethodID ts = (*env)->GetMethodID(env, cls, "toString", "()Ljava/lang/String;");
	jstring s = ts ? (*env)->CallObjectMethod(env, ex, ts) : NULL;
	if ((*env)->ExceptionCheck(env))
		(*env)->ExceptionClear(env);
	if (s) {
		const char *c = (*env)->GetStringUTFChars(env, s, NULL);
		usbfs_set_error("USB %s failed: %s", op, c ? c : "?");
		LOGE("%s", g_err);
		if (c)
			(*env)->ReleaseStringUTFChars(env, s, c);
	}
	errno = EIO;
	return 1;
}

int usbfs_dev_pread(int slot, void *buf, size_t n, int64_t off)
{
	JNIEnv *env = env_get();
	char *p = buf;
	if (!env) {
		errno = EIO;
		return -1;
	}
	while (n > 0) {
		jint len = n > CHUNK ? CHUNK : (jint)n;
		(*env)->CallIntMethod(env, g_slots[slot].obj, m_read, (jlong)off, g_buf, len);
		if (java_failed(env, "read"))
			return -1;
		(*env)->GetByteArrayRegion(env, g_buf, 0, len, (jbyte *)p);
		p += len;
		off += len;
		n -= len;
	}
	return 0;
}

int usbfs_dev_pwrite(int slot, const void *buf, size_t n, int64_t off)
{
	JNIEnv *env = env_get();
	const char *p = buf;
	if (!env) {
		errno = EIO;
		return -1;
	}
	while (n > 0) {
		jint len = n > CHUNK ? CHUNK : (jint)n;
		(*env)->SetByteArrayRegion(env, g_buf, 0, len, (const jbyte *)p);
		(*env)->CallIntMethod(env, g_slots[slot].obj, m_write, (jlong)off, g_buf, len);
		if (java_failed(env, "write"))
			return -1;
		p += len;
		off += len;
		n -= len;
	}
	return 0;
}

int usbfs_dev_sync(int slot)
{
	JNIEnv *env = env_get();
	if (!env) {
		errno = EIO;
		return -1;
	}
	(*env)->CallVoidMethod(env, g_slots[slot].obj, m_sync);
	return java_failed(env, "sync") ? -1 : 0;
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved)
{
	(void)reserved;
	g_vm = vm;
	usbfs_fs_init();
	return JNI_VERSION_1_6;
}

#define JFN(name) Java_com_usbfile_usbstorage_NativeFs_##name

JNIEXPORT jint JNICALL JFN(registerDevice)(JNIEnv *env, jclass cls, jobject dev,
		jlong size, jint sector_size, jlong part_start)
{
	(void)cls;
	if (!g_buf) {
		jclass dc = (*env)->GetObjectClass(env, dev);
		m_read = (*env)->GetMethodID(env, dc, "read", "(J[BI)I");
		m_write = (*env)->GetMethodID(env, dc, "write", "(J[BI)I");
		m_sync = (*env)->GetMethodID(env, dc, "sync", "()V");
		if (!m_read || !m_write || !m_sync)
			return -1;
		jbyteArray b = (*env)->NewByteArray(env, CHUNK);
		if (!b)
			return -1;
		g_buf = (*env)->NewGlobalRef(env, b);
		(*env)->DeleteLocalRef(env, b);
	}
	for (int i = 0; i < MAX_SLOTS; i++) {
		if (!g_slots[i].obj) {
			g_slots[i].obj = (*env)->NewGlobalRef(env, dev);
			g_slots[i].size = size;
			g_slots[i].sector_size = sector_size > 0 ? sector_size : 512;
			g_slots[i].part_start = part_start;
			return i;
		}
	}
	throw_io(env, "too many open USB devices", 0);
	return -1;
}

JNIEXPORT void JNICALL JFN(unregisterDevice)(JNIEnv *env, jclass cls, jint slot)
{
	(void)cls;
	if (slot >= 0 && slot < MAX_SLOTS && g_slots[slot].obj) {
		(*env)->DeleteGlobalRef(env, g_slots[slot].obj);
		memset(&g_slots[slot], 0, sizeof(g_slots[slot]));
	}
}

/* ---------- file systems ---------- */

/* Strings cross JNI as UTF-8 byte arrays: JNI's "modified UTF-8" differs from real UTF-8
   for supplementary characters (emoji) and would corrupt such file names. */
static char *jstr(JNIEnv *env, jbyteArray s)
{
	jsize n = s ? (*env)->GetArrayLength(env, s) : 0;
	char *r = malloc(n + 1);
	if (!r)
		return NULL;
	if (n)
		(*env)->GetByteArrayRegion(env, s, 0, n, (jbyte *)r);
	r[n] = 0;
	return r;
}

static jbyteArray jbytes(JNIEnv *env, const char *s, size_t n)
{
	jbyteArray a = (*env)->NewByteArray(env, (jsize)n);
	if (a && n)
		(*env)->SetByteArrayRegion(env, a, 0, (jsize)n, (const jbyte *)s);
	return a;
}

#define FS(h) ((struct usbfs *)(intptr_t)(h))

JNIEXPORT jlong JNICALL JFN(mount)(JNIEnv *env, jclass cls, jint type, jint slot, jboolean ro)
{
	(void)cls;
	usbfs_clear_error();
	struct usbfs *fs = NULL;
	int rc = usbfs_mount(type, slot, ro, &fs);
	if (rc) {
		throw_io(env, type == USBFS_NTFS ? "NTFS mount failed" : "exFAT mount failed", rc);
		return 0;
	}
	return (jlong)(intptr_t)fs;
}

JNIEXPORT void JNICALL JFN(unmount)(JNIEnv *env, jclass cls, jlong h)
{
	(void)cls;
	usbfs_clear_error();
	int rc = usbfs_unmount(FS(h));
	if (rc)
		throw_io(env, "unmount failed", rc);
}

JNIEXPORT jboolean JNICALL JFN(isReadOnly)(JNIEnv *env, jclass cls, jlong h)
{
	(void)env; (void)cls;
	return usbfs_is_ro(FS(h)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jbyteArray JNICALL JFN(roReason)(JNIEnv *env, jclass cls, jlong h)
{
	(void)cls;
	const char *r = usbfs_ro_reason(FS(h));
	return jbytes(env, r, strlen(r));
}

JNIEXPORT jbyteArray JNICALL JFN(label)(JNIEnv *env, jclass cls, jlong h)
{
	(void)cls;
	char buf[512];
	buf[0] = 0;
	usbfs_label(FS(h), buf, sizeof(buf));
	return jbytes(env, buf, strlen(buf));
}

JNIEXPORT jlongArray JNICALL JFN(space)(JNIEnv *env, jclass cls, jlong h)
{
	(void)cls;
	jlong v[2];
	int64_t total = 0, free_ = 0;
	usbfs_space(FS(h), &total, &free_);
	v[0] = total;
	v[1] = free_;
	jlongArray a = (*env)->NewLongArray(env, 2);
	(*env)->SetLongArrayRegion(env, a, 0, 2, v);
	return a;
}

/* entries are encoded as "<d|f>|<size>|<mtime ms>|<name>" */
struct list_ctx {
	JNIEnv *env;
	void *unused;
	int count, cap;
	char **items;
};

static int list_add(void *p, const char *name, int is_dir, int64_t size, int64_t mtime_ms)
{
	struct list_ctx *c = p;
	if (c->count == c->cap) {
		int ncap = c->cap ? c->cap * 2 : 64;
		char **n = realloc(c->items, ncap * sizeof(char *));
		if (!n)
			return -ENOMEM;
		c->items = n;
		c->cap = ncap;
	}
	size_t len = strlen(name) + 64;
	char *s = malloc(len);
	if (!s)
		return -ENOMEM;
	snprintf(s, len, "%c|%lld|%lld|%s", is_dir ? 'd' : 'f', (long long)size,
			(long long)mtime_ms, name);
	c->items[c->count++] = s;
	return 0;
}

/* all entries in one UTF-8 byte array, each terminated by NUL */
static jbyteArray list_finish(JNIEnv *env, struct list_ctx *c)
{
	size_t total = 0, pos = 0;
	for (int i = 0; i < c->count; i++)
		total += strlen(c->items[i]) + 1;
	char *all = malloc(total ? total : 1);
	for (int i = 0; i < c->count; i++) {
		size_t l = strlen(c->items[i]) + 1;
		if (all)
			memcpy(all + pos, c->items[i], l);
		pos += l;
		free(c->items[i]);
	}
	free(c->items);
	jbyteArray a = all ? jbytes(env, all, total) : NULL;
	free(all);
	return a;
}

JNIEXPORT jbyteArray JNICALL JFN(list)(JNIEnv *env, jclass cls, jlong h, jbyteArray jpath)
{
	(void)cls;
	usbfs_clear_error();
	char *path = jstr(env, jpath);
	struct list_ctx c = { env, NULL, 0, 0, NULL };
	int rc = usbfs_list(FS(h), path, list_add, &c);
	free(path);
	if (rc) {
		for (int i = 0; i < c.count; i++)
			free(c.items[i]);
		free(c.items);
		throw_io(env, "list failed", rc);
		return NULL;
	}
	return list_finish(env, &c);
}

JNIEXPORT jbyteArray JNICALL JFN(stat)(JNIEnv *env, jclass cls, jlong h, jbyteArray jpath)
{
	(void)cls;
	usbfs_clear_error();
	char *path = jstr(env, jpath);
	struct list_ctx c = { env, NULL, 0, 0, NULL };
	int rc = usbfs_stat(FS(h), path, list_add, &c);
	free(path);
	if (rc == -ENOENT || (!rc && c.count == 0)) {
		free(c.items);
		return NULL;
	}
	if (rc) {
		throw_io(env, "stat failed", rc);
		return NULL;
	}
	jbyteArray s = jbytes(env, c.items[0], strlen(c.items[0]));
	free(c.items[0]);
	free(c.items);
	return s;
}

JNIEXPORT jint JNICALL JFN(read)(JNIEnv *env, jclass cls, jlong h, jbyteArray jpath,
		jlong offset, jbyteArray buf, jint len)
{
	(void)cls;
	usbfs_clear_error();
	char *path = jstr(env, jpath);
	void *tmp = malloc(len > 0 ? len : 1);
	int64_t got = 0;
	int rc = tmp ? usbfs_read(FS(h), path, offset, tmp, len, &got) : -ENOMEM;
	free(path);
	if (rc) {
		free(tmp);
		throw_io(env, "read failed", rc);
		return -1;
	}
	(*env)->SetByteArrayRegion(env, buf, 0, (jint)got, tmp);
	free(tmp);
	return (jint)got;
}

JNIEXPORT jlong JNICALL JFN(openWrite)(JNIEnv *env, jclass cls, jlong h, jbyteArray jpath)
{
	(void)cls;
	usbfs_clear_error();
	char *path = jstr(env, jpath);
	void *fh = NULL;
	int rc = usbfs_open_write(FS(h), path, &fh);
	free(path);
	if (rc) {
		throw_io(env, "create failed", rc);
		return 0;
	}
	return (jlong)(intptr_t)fh;
}

JNIEXPORT void JNICALL JFN(write)(JNIEnv *env, jclass cls, jlong h, jlong fh, jlong offset,
		jbyteArray buf, jint len)
{
	(void)cls;
	usbfs_clear_error();
	jbyte *p = (*env)->GetByteArrayElements(env, buf, NULL);
	int rc = usbfs_write(FS(h), (void *)(intptr_t)fh, offset, p, len);
	(*env)->ReleaseByteArrayElements(env, buf, p, JNI_ABORT);
	if (rc)
		throw_io(env, "write failed", rc);
}

JNIEXPORT void JNICALL JFN(closeWrite)(JNIEnv *env, jclass cls, jlong h, jlong fh)
{
	(void)cls;
	usbfs_clear_error();
	int rc = usbfs_close_write(FS(h), (void *)(intptr_t)fh);
	if (rc)
		throw_io(env, "close failed", rc);
}

#define PATH_OP(jname, call, what)                                               \
	JNIEXPORT void JNICALL JFN(jname)(JNIEnv * env, jclass cls, jlong h, jbyteArray jp) \
	{                                                                             \
		(void)cls;                                                                \
		usbfs_clear_error();                                                      \
		char *path = jstr(env, jp);                                               \
		int rc = call(FS(h), path);                                               \
		free(path);                                                               \
		if (rc)                                                                   \
			throw_io(env, what, rc);                                              \
	}

PATH_OP(mkdir, usbfs_mkdir, "mkdir failed")
PATH_OP(remove, usbfs_remove, "delete failed")

JNIEXPORT void JNICALL JFN(rename)(JNIEnv *env, jclass cls, jlong h, jbyteArray jfrom, jbyteArray jto)
{
	(void)cls;
	usbfs_clear_error();
	char *from = jstr(env, jfrom), *to = jstr(env, jto);
	int rc = usbfs_rename(FS(h), from, to);
	free(from);
	free(to);
	if (rc)
		throw_io(env, "rename failed", rc);
}

JNIEXPORT void JNICALL JFN(sync)(JNIEnv *env, jclass cls, jlong h)
{
	(void)cls;
	usbfs_clear_error();
	int rc = usbfs_sync(FS(h));
	if (rc)
		throw_io(env, "sync failed", rc);
}

JNIEXPORT void JNICALL JFN(mkfs)(JNIEnv *env, jclass cls, jint type, jint slot, jbyteArray jlabel)
{
	(void)cls;
	usbfs_clear_error();
	char *label = jstr(env, jlabel);
	int rc = type == USBFS_NTFS ? usbfs_mkntfs(slot, label) : usbfs_mkexfat(slot, label);
	free(label);
	if (rc)
		throw_io(env, type == USBFS_NTFS ? "mkntfs failed" : "mkexfatfs failed", rc > 0 ? 0 : rc);
}
