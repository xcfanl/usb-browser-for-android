export interface Entry {
  name: string
  path: string
  is_dir: boolean
  is_symlink: boolean
  size: number
  modified_ms: number
  ext: string
}

export interface Volume {
  name: string
  path: string
  kind: 'internal' | 'removable' | 'system'
  writable: boolean
  total_bytes: number
  available_bytes: number
  /** 文件系统类型（已知时），如 vfat / exfat / FAT32 / NTFS */
  fs_type: string
  /** system：Android 系统挂载；direct：本应用通过 USB 直接读取 */
  source: 'system' | 'direct'
  free_unknown?: boolean
}

/** StorageManager 报告的存储卷 */
export interface SysVolume {
  name: string
  uuid: string
  state: string
  removable: boolean
  primary: boolean
  path: string
  fsType: string
  /** 经 /proc/self/mountinfo 确认为 USB（SCSI）设备 */
  usb: boolean
}

/** 已连接的 USB 大容量存储设备 */
export interface UsbDev {
  id: number
  deviceName: string
  vendorId: number
  productId: number
  product: string
  manufacturer: string
  hasPermission: boolean
  permissionPending: boolean
  permissionDenied: boolean
  supportedProtocol: boolean
  opened: boolean
  mounted: boolean
  fsType: string
  label: string
  readOnly: boolean
  /** why a normally writable volume is read-only (e.g. hibernated Windows) */
  readOnlyReason?: string
  capacity: number
  free: number
  deviceBytes: number
  error: string
  root: string
}

export interface UsbStatus {
  usbHost: boolean
  volumes: SysVolume[]
  devices: UsbDev[]
  removableMounted: number
}

export interface TextContent {
  text: string
  encoding: string
  size: number
  truncated: boolean
}

export type ViewerKind =
  | 'markdown' | 'html' | 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx'
  | 'video' | 'audio' | 'text' | 'binary'

export type Screen =
  | { t: 'explorer'; root: string }
  | { t: 'editor'; path: string }
  | { t: 'viewer'; kind: ViewerKind; path: string; name: string }

export interface Clipboard {
  mode: 'copy' | 'cut'
  items: string[]
}
