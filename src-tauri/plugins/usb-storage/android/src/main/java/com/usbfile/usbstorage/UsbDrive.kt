package com.usbfile.usbstorage

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.util.Log
import app.tauri.plugin.JSObject
import me.jahnen.libaums.core.driver.BlockDeviceDriver
import me.jahnen.libaums.core.driver.BlockDeviceDriverFactory
import me.jahnen.libaums.core.usb.UsbCommunication
import me.jahnen.libaums.core.usb.UsbCommunicationFactory
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** A USB mass-storage device opened in "direct" mode (bypassing the Android mount). */
internal class UsbDrive(private val usb: UsbManager, val device: UsbDevice) {
  private var comm: UsbCommunication? = null
  var raw: BlockDeviceDriver? = null
    private set
  var fs: RawFs? = null
    private set
  var detected = ""
    private set
  var error = ""
    private set
  private var capacity = 0L
  private var free = 0L
  private var lun = 0

  val isOpen get() = comm != null
  val root get() = "/usbraw/${device.deviceId}"

  companion object {
    private const val TAG = "UsbStorage"

    fun massStorageInterface(d: UsbDevice): UsbInterface? =
      (0 until d.interfaceCount).map { d.getInterface(it) }.firstOrNull {
        it.interfaceClass == UsbConstants.USB_CLASS_MASS_STORAGE
      }
  }

  fun open() {
    val intf = massStorageInterface(device) ?: throw UserError("该 USB 设备不是大容量存储设备")
    if (intf.interfaceSubclass != 6 || intf.interfaceProtocol != 80) {
      throw UserError("不支持的 U 盘协议（仅支持 SCSI / Bulk-Only，当前 subclass=${intf.interfaceSubclass} protocol=${intf.interfaceProtocol}）")
    }
    var inEp: UsbEndpoint? = null
    var outEp: UsbEndpoint? = null
    for (i in 0 until intf.endpointCount) {
      val e = intf.getEndpoint(i)
      if (e.type == UsbConstants.USB_ENDPOINT_XFER_BULK) {
        if (e.direction == UsbConstants.USB_DIR_OUT) outEp = e else inEp = e
      }
    }
    if (inEp == null || outEp == null) throw UserError("U 盘端点不完整，无法通信")
    val c = UsbCommunicationFactory.createUsbCommunication(usb, device, intf, outEp, inEp)
    comm = c
    try {
      val maxLun = ByteArray(1)
      runCatching { c.controlTransfer(161, 254, 0, intf.id, maxLun, 1) } // GET MAX LUN
      var bd: BlockDeviceDriver? = null
      var lastErr: Exception? = null
      for (l in 0..maxLun[0].toInt().coerceIn(0, 15)) {
        val b = BlockDeviceDriverFactory.createBlockDevice(c, l.toByte())
        try {
          b.init()
          bd = b
          lun = l
          break
        } catch (e: Exception) {
          Log.i(TAG, "LUN $l unusable: $e")
          lastErr = e
        }
      }
      if (bd == null && lastErr?.message?.contains("READ CAPACITY(16)") == true) {
        throw UserError("容量超过 2 TB，直接模式暂不支持（libaums 仅支持 READ CAPACITY(10)）")
      }
      raw = bd ?: throw UserError("未检测到存储介质（读卡器中没有卡？）")
      mount()
    } catch (e: Throwable) {
      close()
      throw e
    }
  }

  fun mount() {
    fs?.let { runCatching { it.close() } }
    fs = null
    val r = raw ?: throw UserError("U 盘未打开")
    val res = VolumeProbe.probe(r) { synchronizeCache() }
    fs = res.fs
    detected = res.detected
    error = res.error
    refreshSpace()
  }

  fun refreshSpace() {
    val f = fs
    capacity = f?.capacity() ?: 0L
    free = f?.free() ?: 0L
  }

  fun requireFs(): RawFs = fs ?: throw UserError(if (error.isNotEmpty()) error else "U 盘未以直接模式打开")

  fun format(type: String, label: String) {
    val r = raw ?: throw UserError("U 盘未打开")
    // validate everything before touching the drive
    val kind = type.lowercase()
    val lbl = when (kind) {
      "fat32" -> Fat32Formatter.normalizeLabel(label).also { Fat32Formatter.plan(r.blockSize, r.blocks) }
      "exfat", "ntfs" -> {
        if (!NativeFs.available) throw UserError("原生 exFAT/NTFS 组件加载失败：${NativeFs.loadError}")
        NativeFormatter.checkSize(r)
        NativeFormatter.normalizeLabel(NativeFs.typeOf(kind), label)
      }
      else -> throw UserError("不支持格式化为 $type（可选 FAT32 / exFAT / NTFS）")
    }
    fs?.let { runCatching { it.flush(); it.close() } }
    fs = null
    if (kind == "fat32") Fat32Formatter.format(r, lbl)
    else NativeFormatter.format(r, NativeFs.typeOf(kind), lbl) { synchronizeCache() }
    synchronizeCache()
    mount()
    if (fs == null) throw UserError("格式化已写入，但重新读取失败：$error")
  }

  /** Flush, close the file system and release the USB interface: safe to unplug afterwards. */
  fun close() {
    try {
      fs?.flush()
    } catch (e: Exception) {
      Log.w(TAG, "flush failed", e)
    }
    fs?.let {
      try {
        it.close() // native file systems: unmount writes everything back and marks the volume clean
      } catch (e: Exception) {
        Log.w(TAG, "close failed", e)
      }
    }
    fs = null
    if (raw != null) synchronizeCache()
    raw = null
    comm?.let { runCatching { it.close() } }
    comm = null
  }

  /**
   * Best effort SCSI SYNCHRONIZE CACHE(10) so the drive commits its write cache before the
   * interface is released (libaums does not issue it). Raw Bulk-Only CBW/CSW exchange.
   */
  private fun synchronizeCache() {
    val c = comm ?: return
    try {
      val cbw = ByteBuffer.allocate(31).order(ByteOrder.LITTLE_ENDIAN)
      cbw.putInt(0x43425355) // "USBC"
      cbw.putInt(0x5359_4e43) // tag
      cbw.putInt(0) // no data phase
      cbw.put(0) // flags
      cbw.put(lun.toByte())
      cbw.put(10) // CDB length
      cbw.put(0x35) // SYNCHRONIZE CACHE(10), whole medium
      cbw.position(31)
      cbw.flip()
      if (c.bulkOutTransfer(cbw) != 31) return
      val csw = ByteBuffer.allocate(13).order(ByteOrder.LITTLE_ENDIAN)
      c.bulkInTransfer(csw)
      Log.i(TAG, "SYNCHRONIZE CACHE status=${csw.get(12)}")
    } catch (e: Exception) {
      Log.w(TAG, "SYNCHRONIZE CACHE failed (ignored)", e)
    }
  }

  fun describe(o: JSObject) {
    val f = fs
    o.put("opened", isOpen)
    o.put("mounted", f != null)
    o.put("fsType", f?.typeName ?: detected)
    o.put("label", f?.label ?: "")
    o.put("readOnly", f?.readOnly ?: true)
    o.put("readOnlyReason", f?.readOnlyReason ?: "")
    o.put("capacity", capacity)
    o.put("free", free)
    o.put("deviceBytes", raw?.let { it.blocks * it.blockSize } ?: 0L)
    o.put("error", error)
    o.put("root", root)
  }
}
