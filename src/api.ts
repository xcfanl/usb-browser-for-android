import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import type { Entry, TextContent, Volume } from './types'

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

export async function onVolumesChanged(cb: () => void) {
  const { listen } = await import('@tauri-apps/api/event')
  const un = await listen('volumes-changed', cb)
  return un
}
