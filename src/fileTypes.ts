import type { Entry, ViewerKind } from './types'

export const TEXT_EXTS = new Set([
  'txt', 'log', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less',
  'xml', 'svg', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'rs', 'go', 'sh', 'bash',
  'bat', 'cmd', 'ini', 'cfg', 'conf', 'yml', 'yaml', 'toml', 'properties', 'sql',
  'mdx', 'csv', 'tsv', 'env', 'gitignore', 'gradle', 'plist', 'dtd', 'php', 'rb',
  'kt', 'kts', 'swift', 'dart', 'vue', 'svelte', 'lua', 'r', 'm', 'mm', 'cs',
  'vb', 'asm', 'diff', 'patch', 'lock', 'pub', 'pem', 'crt', 'key', 'csv.gz',
])

export const MD_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd'])
export const HTML_EXTS = new Set(['html', 'htm', 'xhtml'])
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'])
export const PDF_EXTS = new Set(['pdf'])
export const DOCX_EXTS = new Set(['docx'])
export const XLSX_EXTS = new Set(['xlsx', 'xlsm'])
export const PPTX_EXTS = new Set(['pptx'])
export const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', '3gp', 'm4v'])
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'])
export const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'apk', 'jar'])

export function classify(entry: Entry): ViewerKind | 'folder' {
  const e = entry.ext
  if (entry.is_dir) return 'folder'
  if (MD_EXTS.has(e)) return 'markdown'
  if (HTML_EXTS.has(e)) return 'html'
  if (IMAGE_EXTS.has(e)) return 'image'
  if (PDF_EXTS.has(e)) return 'pdf'
  if (DOCX_EXTS.has(e)) return 'docx'
  if (XLSX_EXTS.has(e)) return 'xlsx'
  if (PPTX_EXTS.has(e)) return 'pptx'
  if (VIDEO_EXTS.has(e)) return 'video'
  if (AUDIO_EXTS.has(e)) return 'audio'
  if (TEXT_EXTS.has(e)) return 'text'
  return 'binary'
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

export const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
  txt: 'text/plain', json: 'application/json', html: 'text/html', htm: 'text/html',
  zip: 'application/zip', apk: 'application/vnd.android.package-archive',
}

export function mimeFor(entry: Entry): string {
  if (entry.is_dir) return 'inode/directory'
  return MIME_MAP[entry.ext] ?? '*/*'
}

// 图标（内联 SVG path，viewBox 24）
export const ICONS: Record<string, string> = {
  folder: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z',
  file: 'M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V8h4.5L13 3.5z',
  code: 'M8.7 15.3 5.4 12l3.3-3.3-1.4-1.4L2.6 12l4.7 4.7 1.4-1.4zm6.6 0 3.3-3.3-3.3-3.3 1.4-1.4L21.4 12l-4.7 4.7-1.4-1.4z',
  image: 'M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z',
  pdf: 'M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm4 8H8v6h1.5v-2H10a2 2 0 0 0 0-4zm0 2.5h-.5V11.5h.5a.75.75 0 0 1 0 1.5zm4-2.5h-2v6h2a3 3 0 0 0 0-6zm0 4.5h-.5v-3h.5a1.5 1.5 0 0 1 0 3z',
  doc: 'M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM7 12h10v1.5H7V12zm0 3h10v1.5H7V15zm0-6h10v1.5H7V9z',
  sheet: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 4v2h5V8H5zm7 0v2h7V8h-7zm-7 4v2h5v-2H5zm7 0v2h7v-2h-7zm-7 4v2h5v-2H5zm7 0v2h7v-2h-7z',
  slide: 'M4 3h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm7 14h2v3h-2v-3zM6 6v7h12V6H6z',
  video: 'M17 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.5l5 4v-11l-5 4z',
  audio: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z',
  archive: 'M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6 3h2v2h-2V9zm-2 2h2v2h-2v-2zm2 2h2v2h-2v-2z',
  usb: 'M15 7v4h1v2h-3V5h2l-3-4-3 4h2v8H8v-2.07a3 3 0 1 0-2 0V13a2 2 0 0 0 2 2h3v4a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2v-6h1V7h-4z',
}

export function iconFor(_entry: Entry, kind: string): string {
  switch (kind) {
    case 'folder': return ICONS.folder
    case 'markdown': case 'text': return ICONS.code
    case 'html': return ICONS.code
    case 'image': return ICONS.image
    case 'pdf': return ICONS.pdf
    case 'docx': return ICONS.doc
    case 'xlsx': return ICONS.sheet
    case 'pptx': return ICONS.slide
    case 'video': return ICONS.video
    case 'audio': return ICONS.audio
    case 'archive': return ICONS.archive
    default: return ICONS.file
  }
}

export const KIND_COLORS: Record<string, string> = {
  folder: '#f6c445',
  markdown: '#7e9cff', text: '#9aa4b2', html: '#e5732f', image: '#4fc3f7',
  pdf: '#ef5350', docx: '#42a5f5', xlsx: '#66bb6a', pptx: '#ff7043',
  video: '#ab47bc', audio: '#26c6da', archive: '#a1887f', binary: '#78909c',
}
