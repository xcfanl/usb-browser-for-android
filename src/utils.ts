import type { Entry } from './types'

export function formatSize(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

export function formatTime(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** 自然排序（数字感知、大小写不敏感） */
export function naturalCompare(a: string, b: string): number {
  const ra = a.toLowerCase()
  const rb = b.toLowerCase()
  const chunk = (s: string, i: number): [string | number, number] => {
    if (i >= s.length) return ['', i]
    const c = s[i]
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < s.length && s[j] >= '0' && s[j] <= '9') j++
      return [parseInt(s.slice(i, j), 10), j]
    }
    let j = i + 1
    while (j < s.length && !(s[j] >= '0' && s[j] <= '9')) j++
    return [s.slice(i, j), j]
  }
  let ia = 0, ib = 0
  while (ia < ra.length || ib < rb.length) {
    const [ca, na] = chunk(ra, ia)
    const [cb, nb] = chunk(rb, ib)
    if (typeof ca === 'number' && typeof cb === 'number') {
      if (ca !== cb) return ca - cb
    } else if (ca !== cb) {
      return ca < cb ? -1 : 1
    }
    ia = na
    ib = nb
  }
  return 0
}

export type SortBy = 'name' | 'size' | 'time'

export function sortEntries(list: Entry[], by: SortBy, desc: boolean): Entry[] {
  const dirs = list.filter((e) => e.is_dir)
  const files = list.filter((e) => !e.is_dir)
  const cmp = (a: Entry, b: Entry): number => {
    let r = 0
    if (by === 'name') r = naturalCompare(a.name, b.name)
    else if (by === 'size') r = a.size - b.size
    else r = a.modified_ms - b.modified_ms
    return desc ? -r : r
  }
  dirs.sort(cmp)
  files.sort(cmp)
  return [...dirs, ...files]
}
