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
  | { t: 'browse' }
  | { t: 'editor'; path: string }
  | { t: 'viewer'; kind: ViewerKind; path: string; name: string }

export interface Clipboard {
  mode: 'copy' | 'cut'
  items: string[]
}
