import { useEffect, useRef } from 'react'
import { onVolumesChanged, statPath } from './api'

/**
 * 推断路径所在卷根目录：内部存储 /storage/emulated/0、系统挂载的 OTG 卷 /storage/XXXX-XXXX、
 * 直接模式打开的 U 盘 /usbraw/<id>
 */
function volumeRootOf(path: string): string | null {
  const m = path.match(/^\/storage\/(?:emulated\/\d+|[0-9A-Za-z-]{4,})(?=\/|$)/)
    ?? path.match(/^\/usbraw\/\d+(?=\/|$)/)
  return m ? m[0] : null
}

/**
 * 监听存储卷移除（Android）：后台轮询器发出 volumes-changed 事件时，
 * 校验 path 所在卷根目录是否仍可访问，失效则触发回调。
 * 只对 /storage 与 /usbraw 下的路径生效，桌面端与其它路径不监听。
 */
export function useStorageRemoved(path: string, cb: () => void) {
  const cbRef = useRef(cb)
  cbRef.current = cb
  useEffect(() => {
    const root = volumeRootOf(path)
    if (!root) return
    let un: (() => void) | undefined
    let alive = true
    onVolumesChanged(() => {
      statPath(root).catch(() => {
        if (alive) cbRef.current()
      })
    }).then((u) => {
      if (alive) un = u
      else u()
    })
    return () => {
      alive = false
      un?.()
    }
  }, [path])
}
