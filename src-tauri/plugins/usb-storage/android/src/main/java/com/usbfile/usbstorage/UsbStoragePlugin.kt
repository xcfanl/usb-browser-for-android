package com.usbfile.usbstorage

import android.app.Activity
import androidx.appcompat.app.AppCompatActivity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.os.storage.StorageManager
import android.provider.Settings
import android.util.Log
import android.webkit.WebView
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

private const val TAG = "UsbStorage"
private const val ACTION_USB_PERMISSION = "com.usbfile.usbstorage.USB_PERMISSION"

/**
 * USB storage bridge:
 *  - lists Android storage volumes (StorageManager) and attached USB mass-storage devices,
 *  - requests the per-device USB permission (on attach, on explicit refresh, before direct open),
 *  - "direct mode": talks SCSI to the drive via libaums and reads the file system itself
 *    (FAT32 read/write via libaums; exFAT/NTFS/ext2/3/4/FAT12/16/HFS+ read-only via java-fs),
 *  - FAT32 format and safe eject for drives opened in direct mode.
 * All USB I/O runs on one background thread.
 */
@TauriPlugin
class UsbStoragePlugin(private val activity: Activity) : Plugin(activity) {
  private val ctx: Context = activity.applicationContext
  private val usb = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
  private val sm = ctx.getSystemService(Context.STORAGE_SERVICE) as StorageManager
  private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "usb-storage-io") }
  private val drives = HashMap<Int, UsbDrive>() // io thread only
  private val pending = ConcurrentHashMap<Int, Long>() // deviceId -> request time
  private val denied = ConcurrentHashMap.newKeySet<Int>()
  @Volatile private var receiverRegistered = false

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
      val dev = intent.usbDevice()
      when (intent.action) {
        UsbManager.ACTION_USB_DEVICE_ATTACHED ->
          if (dev != null && isMassStorage(dev)) {
            denied.remove(dev.deviceId)
            requestPermission(dev)
          }
        UsbManager.ACTION_USB_DEVICE_DETACHED -> if (dev != null) {
          pending.remove(dev.deviceId)
          denied.remove(dev.deviceId)
          io.execute { drives.remove(dev.deviceId)?.close() }
        }
        ACTION_USB_PERMISSION -> if (dev != null) {
          pending.remove(dev.deviceId)
          val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
          if (granted) denied.remove(dev.deviceId) else denied.add(dev.deviceId)
          Log.i(TAG, "USB permission for ${dev.deviceName}: $granted")
        }
      }
    }
  }

  override fun load(webView: WebView) {
    super.load(webView)
    val filter = IntentFilter().apply {
      addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
      addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
      addAction(ACTION_USB_PERMISSION)
    }
    ContextCompat.registerReceiver(ctx, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    receiverRegistered = true
    handleIntent(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    handleIntent(intent)
  }

  override fun onDestroy(activity: AppCompatActivity) {
    if (receiverRegistered) runCatching { ctx.unregisterReceiver(receiver) }
    receiverRegistered = false
    io.execute {
      drives.values.forEach { it.close() }
      drives.clear()
    }
  }

  /** App launched/resumed via the USB_DEVICE_ATTACHED intent-filter. */
  private fun handleIntent(intent: Intent?) {
    if (intent?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) {
      intent.usbDevice()?.let { if (isMassStorage(it)) requestPermission(it) }
    }
  }

  @Suppress("DEPRECATION")
  private fun Intent.usbDevice(): UsbDevice? =
    if (Build.VERSION.SDK_INT >= 33) getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
    else getParcelableExtra(UsbManager.EXTRA_DEVICE)

  private fun isMassStorage(d: UsbDevice) = UsbDrive.massStorageInterface(d) != null

  private fun massStorageDevices() = usb.deviceList.values.filter { isMassStorage(it) }

  /** Shows the system "Allow access to USB device" dialog. Returns true if a request is outstanding. */
  private fun requestPermission(dev: UsbDevice): Boolean {
    if (usb.hasPermission(dev)) return false
    val now = SystemClock.elapsedRealtime()
    val last = pending[dev.deviceId]
    if (last != null && now - last < 15_000) return true
    pending[dev.deviceId] = now
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0) // system adds extras
    val pi = PendingIntent.getBroadcast(
      ctx, dev.deviceId,
      Intent(ACTION_USB_PERMISSION).setPackage(ctx.packageName), // explicit: required for mutable PI on 14+
      flags,
    )
    usb.requestPermission(dev, pi)
    return true
  }

  private fun bg(invoke: Invoke, block: () -> JSObject?) {
    io.execute {
      try {
        invoke.resolve(block() ?: JSObject())
      } catch (e: Throwable) {
        Log.w(TAG, "${invoke.command} failed", e)
        invoke.reject(friendly(e))
      }
    }
  }

  private fun friendly(e: Throwable): String = when (e) {
    is UserError -> e.message ?: "操作失败"
    is FileNotFoundException -> "路径不存在"
    is java.io.IOException -> "U 盘读写失败：${e.message ?: e.javaClass.simpleName}（请确认 U 盘未被拔出）"
    else -> e.message ?: e.toString()
  }

  private fun device(id: Int): UsbDevice =
    massStorageDevices().firstOrNull { it.deviceId == id } ?: throw UserError("U 盘已移除")

  private fun drive(id: Int): UsbDrive {
    val d = drives[id]
    if (d == null || !d.isOpen) throw UserError("U 盘未以直接模式打开，请回到主页重新打开")
    if (usb.deviceList.values.none { it.deviceId == id }) {
      drives.remove(id)?.close()
      throw UserError("U 盘已移除")
    }
    return d
  }

  private fun fsOf(args: JSObject): Pair<UsbDrive, RawFs> {
    val d = drive(args.getInteger("id", -1))
    return d to d.requireFs()
  }

  // ---- mount info ------------------------------------------------------------------------

  /** Best effort: UUID (mount dir name) -> fs type, for volumes backed by a SCSI disk (USB). */
  private fun usbMounts(): Map<String, String> {
    val out = HashMap<String, String>()
    runCatching {
      File("/proc/self/mountinfo").forEachLine { line ->
        val sep = line.indexOf(" - ")
        if (sep < 0) return@forEachLine
        val left = line.substring(0, sep).split(' ')
        val right = line.substring(sep + 3).split(' ')
        if (left.size < 5 || right.size < 2) return@forEachLine
        val major = left[2].substringBefore(':').toIntOrNull() ?: return@forEachLine
        // 8, 65-71, 128-135: sd* SCSI disks (USB mass storage); 179 = mmcblk (SD card)
        val scsi = major == 8 || major in 65..71 || major in 128..135
        val voldUsb = right[1].contains("public:8,") ||
          Regex("public:(6[5-9]|7[01]|12[89]|13[0-5]),").containsMatchIn(right[1])
        if (scsi || voldUsb) out[left[4].substringAfterLast('/')] = right[0]
      }
    }
    return out
  }

  // ---- commands --------------------------------------------------------------------------

  @Command
  fun status(invoke: Invoke) {
    val request = runCatching { invoke.getArgs().getBoolean("request", false) }.getOrDefault(false)
    bg(invoke) {
      val mounts = usbMounts()
      val vols = JSArray()
      var removableMounted = 0
      for (v in sm.storageVolumes) {
        val dir = if (Build.VERSION.SDK_INT >= 30) v.directory else null
        val uuid = v.uuid ?: ""
        val mounted = v.state == Environment.MEDIA_MOUNTED || v.state == Environment.MEDIA_MOUNTED_READ_ONLY
        if (v.isRemovable && mounted) removableMounted++
        vols.put(JSObject().apply {
          put("name", v.getDescription(ctx) ?: "")
          put("uuid", uuid)
          put("state", v.state ?: "")
          put("removable", v.isRemovable)
          put("primary", v.isPrimary)
          put("path", if (mounted) dir?.absolutePath ?: "" else "")
          put("fsType", mounts[uuid] ?: "")
          put("usb", uuid.isNotEmpty() && mounts.containsKey(uuid))
        })
      }
      val attached = massStorageDevices()
      val ids = attached.map { it.deviceId }.toSet()
      drives.keys.filter { it !in ids }.forEach { drives.remove(it)?.close() }
      val devs = JSArray()
      for (d in attached) {
        if (request) {
          denied.remove(d.deviceId)
          requestPermission(d)
        }
        val o = JSObject()
        o.put("id", d.deviceId)
        o.put("deviceName", d.deviceName)
        o.put("vendorId", d.vendorId)
        o.put("productId", d.productId)
        o.put("product", runCatching { d.productName }.getOrNull() ?: "")
        o.put("manufacturer", runCatching { d.manufacturerName }.getOrNull() ?: "")
        o.put("hasPermission", usb.hasPermission(d))
        o.put("permissionPending", pending.containsKey(d.deviceId) && !usb.hasPermission(d))
        o.put("permissionDenied", denied.contains(d.deviceId) && !usb.hasPermission(d))
        val intf = UsbDrive.massStorageInterface(d)
        o.put("supportedProtocol", intf != null && intf.interfaceSubclass == 6 && intf.interfaceProtocol == 80)
        val drive = drives[d.deviceId]
        if (drive != null) drive.describe(o) else {
          o.put("opened", false); o.put("mounted", false); o.put("fsType", ""); o.put("label", "")
          o.put("readOnly", true); o.put("capacity", 0L); o.put("free", 0L); o.put("deviceBytes", 0L)
          o.put("error", ""); o.put("root", "/usbraw/${d.deviceId}")
        }
        devs.put(o)
      }
      JSObject().apply {
        put("usbHost", ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST))
        put("volumes", vols)
        put("devices", devs)
        put("removableMounted", removableMounted)
      }
    }
  }

  @Command
  fun requestPermission(invoke: Invoke) {
    val id = invoke.getArgs().getInteger("id", -1)
    bg(invoke) {
      var requested = 0
      for (d in massStorageDevices()) {
        if (id >= 0 && d.deviceId != id) continue
        denied.remove(d.deviceId)
        if (requestPermission(d)) requested++
      }
      JSObject().apply { put("requested", requested) }
    }
  }

  @Command
  fun open(invoke: Invoke) {
    val id = invoke.getArgs().getInteger("id", -1)
    bg(invoke) {
      val dev = device(id)
      if (!usb.hasPermission(dev)) {
        requestPermission(dev)
        throw UserError("需要 USB 访问授权：请在系统弹窗中点击“允许”，然后再次打开")
      }
      val d = drives[id]?.takeIf { it.isOpen } ?: UsbDrive(usb, dev).also {
        it.open()
        drives[id] = it
      }
      JSObject().also { d.describe(it) }
    }
  }

  @Command
  fun eject(invoke: Invoke) {
    val id = invoke.getArgs().getInteger("id", -1)
    bg(invoke) {
      drives.remove(id)?.close()
      null
    }
  }

  @Command
  fun format(invoke: Invoke) {
    val a = invoke.getArgs()
    val id = a.getInteger("id", -1)
    val type = a.getString("fsType", "fat32") ?: "fat32"
    val label = a.getString("label", "") ?: ""
    bg(invoke) {
      val d = drive(id)
      d.format(type, label)
      JSObject().also { d.describe(it) }
    }
  }

  @Command
  fun list(invoke: Invoke) {
    val a = invoke.getArgs()
    bg(invoke) {
      val (_, fs) = fsOf(a)
      val arr = JSArray()
      for (e in fs.list(a.getString("path", "/") ?: "/")) arr.put(entryJson(e))
      JSObject().apply { put("entries", arr) }
    }
  }

  @Command
  fun stat(invoke: Invoke) {
    val a = invoke.getArgs()
    bg(invoke) {
      val (_, fs) = fsOf(a)
      entryJson(fs.stat(a.getString("path", "/") ?: "/"))
    }
  }

  /** Copies a file or directory from the drive to a local path (cache / internal storage). */
  @Command
  fun exportPath(invoke: Invoke) {
    val a = invoke.getArgs()
    bg(invoke) {
      val (_, fs) = fsOf(a)
      val max = a.optLong("max", Long.MAX_VALUE).let { if (it <= 0) Long.MAX_VALUE else it }
      exportRec(fs, a.getString("path", "/") ?: "/", File(a.getString("dest", "") ?: ""), max, 0)
      null
    }
  }

  private fun exportRec(fs: RawFs, path: String, dest: File, max: Long, depth: Int) {
    if (depth > 40) throw UserError("目录层级过深")
    val st = fs.stat(path)
    if (st.isDir) {
      dest.mkdirs()
      for (c in fs.list(path)) exportRec(fs, childPath(path, c.name), File(dest, c.name), max, depth + 1)
    } else {
      dest.parentFile?.mkdirs()
      val tmp = File(dest.path + ".part")
      try {
        FileOutputStream(tmp).use { fs.readTo(path, it, max) }
        if (!tmp.renameTo(dest)) {
          dest.delete()
          if (!tmp.renameTo(dest)) throw UserError("无法写入 ${dest.path}")
        }
      } finally {
        tmp.delete()
      }
      if (st.mtime > 0) dest.setLastModified(st.mtime)
    }
  }

  /** Copies a local file or directory onto the drive at `path` (overwrites files). */
  @Command
  fun importPath(invoke: Invoke) {
    val a = invoke.getArgs()
    bg(invoke) {
      val (d, fs) = fsOf(a)
      if (fs.readOnly) throw UserError("${fs.typeName} 在直接模式下为只读")
      try {
        importRec(fs, File(a.getString("src", "") ?: ""), a.getString("path", "") ?: "", 0)
      } finally {
        fs.flush()
        d.refreshSpace()
      }
      null
    }
  }

  private fun importRec(fs: RawFs, src: File, path: String, depth: Int) {
    if (depth > 40) throw UserError("目录层级过深")
    if (src.isDirectory) {
      runCatching { fs.mkdir(path) }
      src.listFiles()?.forEach { importRec(fs, it, childPath(path, it.name), depth + 1) }
    } else {
      FileInputStream(src).use { fs.writeFrom(path, it) }
    }
  }

  @Command
  fun mkdir(invoke: Invoke) {
    val a = invoke.getArgs()
    bg(invoke) {
      val (d, fs) = fsOf(a)
      fs.mkdir(a.getString("path", "") ?: "")
      fs.flush(); d.refreshSpace()
      null
    }
  }

  @Command
  fun delete(invoke: Invoke) {
    val a = invoke.getArgs()
    bg(invoke) {
      val (d, fs) = fsOf(a)
      fs.delete(a.getString("path", "") ?: "")
      fs.flush(); d.refreshSpace()
      null
    }
  }

  @Command
  fun rename(invoke: Invoke) {
    val a = invoke.getArgs()
    bg(invoke) {
      val (_, fs) = fsOf(a)
      fs.rename(a.getString("path", "") ?: "", a.getString("newName", "") ?: "")
      fs.flush()
      null
    }
  }

  @Command
  fun search(invoke: Invoke) {
    val a = invoke.getArgs()
    bg(invoke) {
      val (_, fs) = fsOf(a)
      val q = (a.getString("query", "") ?: "").lowercase()
      val limit = a.getInteger("limit", 200).coerceIn(1, 500)
      val hits = JSArray()
      var count = 0
      var visited = 0
      val queue = ArrayDeque<Pair<String, Int>>()
      queue.add((a.getString("path", "/") ?: "/") to 0)
      loop@ while (queue.isNotEmpty()) {
        val (dir, depth) = queue.removeFirst()
        if (depth > 10) continue
        val items = runCatching { fs.list(dir) }.getOrNull() ?: continue
        for (e in items) {
          if (++visited > 20000 || count >= limit) break@loop
          if (e.name.startsWith(".")) continue
          val p = childPath(dir, e.name)
          if (e.name.lowercase().contains(q)) {
            hits.put(entryJson(e).apply { put("path", p) })
            count++
          }
          if (e.isDir) queue.add(p to depth + 1)
        }
      }
      JSObject().apply { put("entries", hits) }
    }
  }

  /** System storage settings: the only legitimate place to eject/format system-mounted volumes. */
  @Command
  fun openStorageSettings(invoke: Invoke) {
    activity.runOnUiThread {
      val intents = listOf(
        Intent(Settings.ACTION_INTERNAL_STORAGE_SETTINGS),
        Intent(Settings.ACTION_MEMORY_CARD_SETTINGS),
        Intent(Settings.ACTION_SETTINGS),
      )
      val ok = intents.any { i ->
        runCatching { activity.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true }.getOrDefault(false)
      }
      if (ok) invoke.resolve() else invoke.reject("无法打开系统设置")
    }
  }

  private fun entryJson(e: RawEntry) = JSObject().apply {
    put("name", e.name)
    put("isDir", e.isDir)
    put("size", e.size)
    put("mtime", e.mtime)
  }
}
