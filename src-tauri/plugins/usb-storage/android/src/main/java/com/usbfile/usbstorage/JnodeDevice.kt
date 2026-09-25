/*
 * Adapted from libaums' javafs module (me.jahnen.libaums.javafs.wrapper.device.*),
 * Copyright (C) magnusja, licensed under the Apache License, Version 2.0.
 * Changes: Kotlin port, byte-addressed partition view, writes rejected (read-only use).
 */
package com.usbfile.usbstorage

import me.jahnen.libaums.core.driver.BlockDeviceDriver
import org.jnode.driver.Device
import org.jnode.driver.block.BlockDeviceAPI
import org.jnode.driver.block.FSBlockDeviceAPI
import org.jnode.partitions.PartitionTable
import org.jnode.partitions.PartitionTableEntry
import java.io.IOException
import java.nio.ByteBuffer

/** [byteDevice] must be byte addressed (libaums ByteBlockDevice over the partition). */
internal class JnodeBlockApi(
  private val byteDevice: BlockDeviceDriver,
  private val sectorSize: Int,
  private val length: Long,
) : FSBlockDeviceAPI {
  override fun getSectorSize(): Int = sectorSize

  override fun getPartitionTableEntry(): PartitionTableEntry = object : PartitionTableEntry {
    override fun isValid(): Boolean = true
    override fun hasChildPartitionTable(): Boolean = false
    override fun getChildPartitionTable(): PartitionTable<*>? = null
  }

  override fun getLength(): Long = length

  override fun read(devOffset: Long, dest: ByteBuffer) {
    byteDevice.read(devOffset, dest)
  }

  override fun write(devOffset: Long, src: ByteBuffer) {
    throw IOException("read-only")
  }

  override fun flush() {}
}

internal class JnodeDevice(api: JnodeBlockApi) : Device("usb-storage") {
  init {
    registerAPI(FSBlockDeviceAPI::class.java, api)
    registerAPI(BlockDeviceAPI::class.java, api)
  }
}
