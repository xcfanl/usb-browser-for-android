import type { Volume } from '../types'
import { formatSize } from '../utils'
import { Icon, PATHS } from '../ui'

const VOL_COLORS: Record<string, string> = {
  internal: '#4fc3f7',
  removable: '#66bb6a',
  system: '#ffb74d',
}

export default function Home({ volumes, onPick, onRefresh, loading }: {
  volumes: Volume[]
  onPick: (v: Volume) => void
  onRefresh: () => void
  loading: boolean
}) {
  return (
    <div className="home-screen">
      <header className="topbar">
        <div className="home-title">
          <span className="row-name">USB文件浏览器</span>
          <span className="editor-sub">选择要浏览的存储位置</span>
        </div>
        <button className="icon-btn" onClick={onRefresh} aria-label="刷新">
          <Icon d={PATHS.refresh} />
        </button>
      </header>
      <main className="list home-list">
        {volumes.map((v) => {
          const pct = v.total_bytes > 0
            ? Math.round(((v.total_bytes - v.available_bytes) / v.total_bytes) * 100)
            : 0
          const color = VOL_COLORS[v.kind] ?? '#4fc3f7'
          return (
            <button key={v.path} className="vol-card" onClick={() => onPick(v)}>
              <span className="vol-icon" style={{ background: `${color}22`, color }}>
                <Icon d={v.kind === 'removable' ? PATHS.usb : PATHS.home} size={24} />
              </span>
              <div className="vol-main">
                <div className="row-name">{v.name}</div>
                <div className="usage-bar"><div style={{ width: `${pct}%` }} /></div>
                <div className="usage-text">
                  {v.total_bytes > 0
                    ? `${formatSize(v.available_bytes)} 可用 / 共 ${formatSize(v.total_bytes)}`
                    : ''}
                </div>
              </div>
              <Icon d={PATHS.open} className="vol-arrow" size={18} />
            </button>
          )
        })}
        {!volumes.length && (
          <div className="hint">{loading ? '正在检测存储…' : '未检测到可用存储，请插入 USB 设备或点击右上角刷新'}</div>
        )}
      </main>
    </div>
  )
}
