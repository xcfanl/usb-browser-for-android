import { useState } from 'react'
import type { UsbDev, UsbStatus, Volume } from '../types'
import { formatSize } from '../utils'
import { ConfirmDialog, Icon, PATHS } from '../ui'
import * as api from '../api'
import FormatDialog from './FormatDialog'

type DevState =
  | 'noProtocol' | 'needPermission' | 'pending' | 'denied'
  | 'systemMounted' | 'ready' | 'opened' | 'unsupported'

function devTitle(d: UsbDev) {
  const name = [d.manufacturer, d.product].filter(Boolean).join(' ').trim()
  return name || `USB 存储设备 ${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`
}

/** 系统是否（可能）已挂载了某个 U 盘 */
function systemMountInfo(status: UsbStatus): { mounted: boolean; certain: boolean } {
  const usbVol = status.volumes.some((v) => v.usb && v.path)
  if (usbVol) return { mounted: true, certain: true }
  const anyUsbFlag = status.volumes.some((v) => v.usb)
  // /proc 信息不可用时，按“有可移除卷已挂载”推测（也可能是 SD 卡）
  if (!anyUsbFlag && status.removableMounted > 0) return { mounted: true, certain: false }
  return { mounted: false, certain: true }
}

function stateOf(d: UsbDev, sysMounted: boolean): DevState {
  if (!d.supportedProtocol) return 'noProtocol'
  if (d.opened) return d.mounted ? 'opened' : 'unsupported'
  if (!d.hasPermission) return d.permissionPending ? 'pending' : d.permissionDenied ? 'denied' : 'needPermission'
  return sysMounted ? 'systemMounted' : 'ready'
}

function UsageBar({ total, free }: { total: number; free: number }) {
  if (total <= 0) return null
  if (free < 0) return <div className="usage-text">共 {formatSize(total)}（可用空间未知）</div>
  const pct = Math.round(((total - free) / total) * 100)
  return (
    <>
      <div className="usage-bar"><div style={{ width: `${pct}%` }} /></div>
      <div className="usage-text">
        已用 {formatSize(total - free)} · 可用 {formatSize(free)} / 共 {formatSize(total)}
      </div>
    </>
  )
}

export default function Home({ volumes, usb, onPick, onRefresh, loading, toast }: {
  volumes: Volume[]
  usb: UsbStatus | null
  onPick: (v: Volume) => void
  onRefresh: () => void
  loading: boolean
  toast: (m: string) => void
}) {
  const [busy, setBusy] = useState<number | null>(null)
  const [formatFor, setFormatFor] = useState<UsbDev | null>(null)
  const [takeover, setTakeover] = useState<UsbDev | null>(null)
  const [ejectFor, setEjectFor] = useState<UsbDev | null>(null)

  const sysVolumes = volumes.filter((v) => v.source !== 'direct')
  const directVolumes = volumes.filter((v) => v.source === 'direct')
  const sys = usb ? systemMountInfo(usb) : { mounted: false, certain: true }
  const hasSystemRemovable = sysVolumes.some((v) => v.kind === 'removable')

  const run = async (id: number, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id)
    try {
      await fn()
      if (ok) toast(ok)
    } catch (e) {
      toast(String(e))
    } finally {
      setBusy(null)
      onRefresh()
    }
  }

  const openDirect = (d: UsbDev) =>
    run(d.id, async () => {
      const r = await api.usbOpen(d.id)
      if (!r.mounted) throw new Error(r.error || '无法读取文件系统')
      toast(`已通过直接模式打开（${r.fsType}${r.readOnly ? '，只读' : '，可读写'}）${r.readOnly && r.readOnlyReason ? '：' + r.readOnlyReason : ''}`)
    })

  const pickDirect = (d: UsbDev) => {
    const v = directVolumes.find((x) => x.path === d.root)
    if (v) onPick(v)
  }

  const renderDevice = (d: UsbDev) => {
    const st = stateOf(d, sys.mounted)
    const isBusy = busy === d.id
    let desc: React.ReactNode = null
    let actions: React.ReactNode = null
    switch (st) {
      case 'noProtocol':
        desc = '该设备使用了不支持的协议（仅支持 SCSI / Bulk-Only 的 U 盘、读卡器和移动硬盘）。'
        break
      case 'needPermission':
        desc = '需要你授权本应用访问此 U 盘。'
        actions = <button className="btn primary" disabled={isBusy} onClick={() => run(d.id, () => api.usbRequestPermission(d.id))}>授权访问</button>
        break
      case 'pending':
        desc = '已请求授权：请在系统弹窗中点击“允许”（勾选“默认打开”后以后插入会自动授权）。'
        actions = <button className="btn ghost" disabled={isBusy} onClick={() => run(d.id, () => api.usbRequestPermission(d.id))}>重新弹出授权</button>
        break
      case 'denied':
        desc = '你拒绝了 USB 访问授权，本应用无法直接读取此 U 盘。'
        actions = <button className="btn primary" disabled={isBusy} onClick={() => run(d.id, () => api.usbRequestPermission(d.id))}>重新授权</button>
        break
      case 'systemMounted':
        desc = (
          <>
            {sys.certain ? '系统已挂载此 U 盘' : '系统可能已挂载此 U 盘'}
            ，请点击上方“存储”中的外接存储浏览。系统挂载的 U 盘不能由应用弹出或格式化，
            请使用系统设置；也可以改用直接模式（由本应用接管）。
          </>
        )
        actions = (
          <>
            <button className="btn ghost" onClick={() => api.openStorageSettings().catch((e) => toast(String(e)))}>系统存储设置</button>
            <button className="btn ghost" disabled={isBusy} onClick={() => setTakeover(d)}>改用直接模式</button>
          </>
        )
        break
      case 'ready':
        desc = '系统没有挂载此 U 盘（可能是系统不支持的格式，如 NTFS / exFAT / ext4，或需要开启 OTG）。可用直接模式打开（FAT32 / exFAT / NTFS 可读写）。'
        actions = <button className="btn primary" disabled={isBusy} onClick={() => openDirect(d)}>{isBusy ? '正在打开…' : '直接读取打开'}</button>
        break
      case 'opened':
        desc = (
          <>
            <div className="usb-tags">
              <span className="usb-tag">{d.fsType || '未知格式'}</span>
              {d.label && <span className="usb-tag">卷标 {d.label}</span>}
              <span className={`usb-tag ${d.readOnly ? 'warn' : 'ok'}`}>{d.readOnly ? '只读' : '可读写'}</span>
              <span className="usb-tag">直接模式</span>
            </div>
            {d.readOnly && d.readOnlyReason && <div className="usb-note">{d.readOnlyReason}</div>}
            <UsageBar total={d.capacity} free={d.free} />
          </>
        )
        actions = (
          <>
            <button className="btn primary" onClick={() => pickDirect(d)}>浏览</button>
            <button className="btn ghost" disabled={isBusy} onClick={() => setEjectFor(d)}>弹出</button>
            <button className="btn ghost danger-text" disabled={isBusy} onClick={() => setFormatFor(d)}>格式化</button>
          </>
        )
        break
      case 'unsupported':
        desc = (
          <>
            <div className="usb-tags">
              {d.fsType && <span className="usb-tag warn">{d.fsType}</span>}
              <span className="usb-tag">直接模式</span>
            </div>
            <div>{d.error || '无法读取此 U 盘的文件系统'}</div>
          </>
        )
        actions = (
          <>
            <button className="btn ghost" disabled={isBusy} onClick={() => setEjectFor(d)}>弹出</button>
            <button className="btn ghost danger-text" disabled={isBusy} onClick={() => setFormatFor(d)}>格式化为 FAT32</button>
          </>
        )
        break
    }
    return (
      <div key={d.id} className="usb-card">
        <div className="usb-card-head">
          <span className="vol-icon k-removable"><Icon d={PATHS.usb} size={23} /></span>
          <div className="vol-main">
            <div className="row-name">{devTitle(d)}</div>
            <div className="usage-text">
              {d.deviceBytes > 0 ? `容量 ${formatSize(d.deviceBytes)} · ` : ''}{d.deviceName}
            </div>
          </div>
        </div>
        {desc && <div className="usb-desc">{desc}</div>}
        {actions && <div className="usb-actions">{actions}</div>}
      </div>
    )
  }

  return (
    <div className="home-screen">
      <header className="topbar">
        <div className="home-title">
          <span className="row-name">USB文件浏览器</span>
          <span className="editor-sub">选择要浏览的存储位置</span>
        </div>
        <button className="icon-btn" onClick={onRefresh} aria-label="刷新并扫描 USB">
          <Icon d={PATHS.refresh} />
        </button>
      </header>
      <main className="list home-list">
        {sysVolumes.length > 0 && <div className="home-section">存储</div>}
        {sysVolumes.map((v) => (
          <button key={v.path} className="vol-card" onClick={() => onPick(v)}>
            <span className={`vol-icon k-${v.kind}`}>
              <Icon d={v.kind === 'removable' ? PATHS.usb : PATHS.home} size={23} />
            </span>
            <div className="vol-main">
              <div className="row-name">
                {v.name}
                {v.fs_type && <span className="usb-tag inline">{v.fs_type}</span>}
                {v.kind === 'removable' && <span className="usb-tag inline">系统挂载</span>}
              </div>
              <UsageBar total={v.total_bytes} free={v.available_bytes} />
            </div>
            <Icon d={PATHS.open} className="vol-arrow" size={18} />
          </button>
        ))}
        {hasSystemRemovable && (
          <button className="link-btn" onClick={() => api.openStorageSettings().catch((e) => toast(String(e)))}>
            弹出 / 格式化系统挂载的 U 盘：打开系统存储设置
          </button>
        )}

        {usb && (
          <>
            <div className="home-section">USB 设备</div>
            {!usb.usbHost && (
              <div className="usb-card"><div className="usb-desc">此手机未声明支持 USB 主机（OTG）模式，可能无法连接 U 盘。</div></div>
            )}
            {usb.devices.map(renderDevice)}
            {usb.devices.length === 0 && (
              <div className="usb-card">
                <div className="usb-desc">
                  未检测到 USB 存储设备。请通过 OTG 转接头插入 U 盘；部分手机需要先在“设置”中打开“OTG 连接”开关（闲置一段时间后可能自动关闭）。
                </div>
              </div>
            )}
          </>
        )}

        {!volumes.length && !usb && (
          <div className="hint">{loading ? '正在检测存储…' : '未检测到可用存储，请插入 USB 设备或点击右上角刷新'}</div>
        )}
      </main>

      {formatFor && (
        <FormatDialog
          dev={formatFor}
          title={devTitle(formatFor)}
          onCancel={() => setFormatFor(null)}
          onDone={(msg) => { setFormatFor(null); toast(msg); onRefresh() }}
        />
      )}
      {takeover && (
        <ConfirmDialog
          title="改用直接模式"
          message="本应用将通过 USB 直接接管此 U 盘，系统挂载会被断开（系统可能提示“U 盘意外移除”）。请先确认没有其他应用正在向 U 盘写入数据。继续？"
          onCancel={() => setTakeover(null)}
          onConfirm={() => { const d = takeover; setTakeover(null); openDirect(d) }}
        />
      )}
      {ejectFor && (
        <ConfirmDialog
          title="弹出 U 盘"
          message={`将写入所有缓存数据并断开“${devTitle(ejectFor)}”，完成后即可安全拔出。`}
          onCancel={() => setEjectFor(null)}
          onConfirm={() => {
            const d = ejectFor
            setEjectFor(null)
            run(d.id, () => api.usbEject(d.id), '已安全弹出，现在可以拔出 U 盘')
          }}
        />
      )}
    </div>
  )
}
