import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import type { Entry, TextContent, UsbDev, UsbStatus, Volume } from './types'

export { convertFileSrc }

export const getVolumes = () => invoke<Volume[]>('get_volumes')
export const listDir = (path: string) => invoke<Entry[]>('list_dir', { path })
export const statPath = (path: string) => invoke<Entry>('stat_path', { path })
export const readText = (path: string, maxBytes?: number) =>
  invoke<TextContent>('read_text', { path, maxBytes })
export const writeText = (path: string, content: string) =>
  invoke<void>('write_text', { path, content })
export const createDir = (path: string) => invoke<void>('create_dir', { path })
export const renamePath = (from: string, to: string) =>
  invoke<void>('rename_path', { from, to })
export const deletePath = (path: string) => invoke<void>('delete_path', { path })
export const copyPaths = (sources: string[], dstDir: string) =>
  invoke<string[]>('copy_paths', { sources, dstDir })
export const movePaths = (sources: string[], dstDir: string) =>
  invoke<string[]>('move_paths', { sources, dstDir })
export const search = (path: string, query: string, limit?: number) =>
  invoke<Entry[]>('search', { path, query, limit })
export const checkAllFilesAccess = () => invoke<boolean>('check_all_files_access')
export const requestAllFilesAccess = () => invoke<void>('request_all_files_access')
export const openWithSystem = (path: string, mime: string) =>
  invoke<void>('open_with_system', { path, mime })

/* ---- USB（Android）---- */
/** request=true 时会为尚未授权的 U 盘弹出系统 USB 授权对话框（扫描/刷新时使用） */
export const usbStatus = (request = false) => invoke<UsbStatus>('usb_status', { request })
export const usbRequestPermission = (id?: number) =>
  invoke<{ requested: number }>('usb_request_permission', { id })
export const usbOpen = (id: number) => invoke<UsbDev>('usb_open', { id })
export const usbEject = (id: number) => invoke<void>('usb_eject', { id })
export const usbFormat = (id: number, fsType: string, label: string) =>
  invoke<UsbDev>('usb_format', { id, fsType, label })
/** 直接模式下的 U 盘文件复制到缓存，返回本地路径（其他路径原样返回） */
export const usbMaterialize = (path: string) => invoke<string>('usb_materialize', { path })
export const openStorageSettings = () => invoke<void>('open_storage_settings')
export const isRawPath = (p: string) => p.startsWith('/usbraw/')

export async function onVolumesChanged(cb: () => void) {
  const { listen } = await import('@tauri-apps/api/event')
  const un = await listen('volumes-changed', cb)
  return un
}
