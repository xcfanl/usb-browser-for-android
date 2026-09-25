import { useState } from 'react'
import type { UsbDev } from '../types'
import { formatSize } from '../utils'
import { Modal } from '../ui'
import * as api from '../api'

const CONFIRM_WORD = '格式化'

const FS_OPTIONS: { key: string; label: string; enabled: boolean; note: string }[] = [
  { key: 'fat32', label: 'FAT32', enabled: true, note: '兼容性最好（手机、电脑、车机、电视），单个文件不超过 4 GB' },
  { key: 'exfat', label: 'exFAT', enabled: false, note: '暂不支持：目前没有许可证兼容且经过验证的 exFAT 格式化实现' },
  { key: 'ntfs', label: 'NTFS', enabled: false, note: '暂不支持' },
]

/** 强确认的格式化对话框：显示设备名/容量，选择文件系统与卷标，勾选并输入确认词。 */
export default function FormatDialog({ dev, title, onCancel, onDone }: {
  dev: UsbDev
  title: string
  onCancel: () => void
  onDone: (msg: string) => void
}) {
  const [fsType, setFsType] = useState('fat32')
  const [label, setLabel] = useState(dev.label || 'USB')
  const [ack, setAck] = useState(false)
  const [word, setWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const labelOk = /^[A-Za-z0-9 _\-!#$%&'()@^`{}~]{0,11}$/.test(label)
  const canGo = !busy && ack && word.trim() === CONFIRM_WORD && labelOk && fsType === 'fat32'

  const go = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await api.usbFormat(dev.id, fsType, label.trim())
      onDone(`格式化完成：${r.fsType}${r.label ? `（${r.label}）` : ''}，可用 ${formatSize(r.free)}`)
    } catch (e) {
      setErr(String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="格式化 U 盘" onClose={busy ? undefined : onCancel}>
      <div className="format-warn">
        将永久清除 <b>{title}</b>
        {dev.deviceBytes > 0 && <>（{formatSize(dev.deviceBytes)}）</>}
        上的<b>全部数据和分区</b>，无法恢复。
        {dev.fsType && <> 当前格式：{dev.fsType}{dev.label ? `，卷标 ${dev.label}` : ''}。</>}
      </div>
      <div className="format-field">
        <div className="format-label">文件系统</div>
        {FS_OPTIONS.map((o) => (
          <label key={o.key} className={`format-radio ${o.enabled ? '' : 'disabled'}`}>
            <input
              type="radio" name="fs" value={o.key} disabled={!o.enabled || busy}
              checked={fsType === o.key} onChange={() => setFsType(o.key)}
            />
            <span><b>{o.label}</b><small>{o.note}</small></span>
          </label>
        ))}
      </div>
      <div className="format-field">
        <div className="format-label">卷标（最多 11 个英文字母/数字）</div>
        <input
          className="input" value={label} maxLength={11} disabled={busy}
          onChange={(e) => setLabel(e.target.value.toUpperCase())}
        />
        {!labelOk && <div className="format-error">卷标只能包含英文字母、数字、空格和 - _ 等符号</div>}
      </div>
      <label className="format-check">
        <input type="checkbox" checked={ack} disabled={busy} onChange={(e) => setAck(e.target.checked)} />
        <span>我已备份需要的数据，了解 U 盘上的所有内容将被删除</span>
      </label>
      <div className="format-field">
        <div className="format-label">请输入“{CONFIRM_WORD}”以确认</div>
        <input className="input" value={word} disabled={busy} placeholder={CONFIRM_WORD} onChange={(e) => setWord(e.target.value)} />
      </div>
      {busy && <div className="format-busy">正在格式化，请勿拔出 U 盘…</div>}
      {err && <div className="format-error">{err}</div>}
      <div className="modal-btns">
        <button className="btn ghost" disabled={busy} onClick={onCancel}>取消</button>
        <button className="btn danger" disabled={!canGo} onClick={go}>{busy ? '格式化中…' : '格式化'}</button>
      </div>
    </Modal>
  )
}
