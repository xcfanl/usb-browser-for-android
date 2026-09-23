import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ICONS } from './fileTypes'

export function Icon({ d, size = 22, color, className }: {
  d: string; size?: number; color?: string; className?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} className={className}
      fill={color ?? 'currentColor'} aria-hidden
    >
      <path d={d} />
    </svg>
  )
}

export const PATHS = {
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  menu: 'M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  search: 'M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',
  refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24L13 11h7V4l-2.35 2.35z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  more: 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  save: 'M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z',
  copy: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z',
  cut: 'M9.64 7.64A3 3 0 1 0 6 10.83V13l6 6 1.41-1.41L9 13.18V10.8a3 3 0 0 0 .64-3.16zM6 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm6 6.87 4.59 4.59L18 19.05l-4.59-4.59-1.41 1.41zM18 5l-6 6 1.41 1.41L19.05 6.4 18 5zm-6 9.87L13.41 16l1.59 1.59L13.41 19 12 17.59 10.59 19 9 17.41l3-3.54z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  rename: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  sort: 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z',
  open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8h5z',
  eye: 'M12 4.5A11.83 11.83 0 0 0 1 12a11.82 11.82 0 0 0 22 0A11.83 11.83 0 0 0 12 4.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  usb: 'M15 7v4h1v2h-3V5h2l-3-4-3 4h2v8H8v-2.07a3 3 0 1 0-2 0V13a2 2 0 0 0 2 2h3v4a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2v-6h1V7h-4z',
  folder: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z',
  file: 'M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V8h4.5L13 3.5z',
  code: 'M8.7 15.3 5.4 12l3.3-3.3-1.4-1.4L2.6 12l4.7 4.7 1.4-1.4zm6.6 0 3.3-3.3-3.3-3.3 1.4-1.4L21.4 12l-4.7 4.7-1.4-1.4z',
  audio: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z',
}

/* ---------------- Dialog ---------------- */

export function Modal({ title, children, onClose }: {
  title: string; children: ReactNode; onClose?: () => void
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        {children}
      </div>
    </div>
  )
}

export function PromptDialog({ title, initial, confirmText, placeholder, onConfirm, onCancel }: {
  title: string; initial?: string; confirmText?: string; placeholder?: string
  onConfirm: (v: string) => void; onCancel: () => void
}) {
  const [v, setV] = useState(initial ?? '')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  return (
    <Modal title={title} onClose={onCancel}>
      <input
        ref={ref} className="input" value={v} placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) onConfirm(v.trim()) }}
      />
      <div className="modal-btns">
        <button className="btn ghost" onClick={onCancel}>取消</button>
        <button className="btn primary" disabled={!v.trim()} onClick={() => onConfirm(v.trim())}>
          {confirmText ?? '确定'}
        </button>
      </div>
    </Modal>
  )
}

export function ConfirmDialog({ title, message, onConfirm, onCancel, danger }: {
  title: string; message: string; onConfirm: () => void; onCancel: () => void; danger?: boolean
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="confirm-msg">{message}</div>
      <div className="modal-btns">
        <button className="btn ghost" onClick={onCancel}>取消</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>确定</button>
      </div>
    </Modal>
  )
}

/* ---------------- Bottom sheet ---------------- */

export interface SheetAction {
  key: string
  label: string
  icon: string
  danger?: boolean
  onClick: () => void
}

export function BottomSheet({ title, subtitle, actions, onClose }: {
  title: string; subtitle?: string; actions: SheetAction[]; onClose: () => void
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div className="sheet-title">{title}</div>
          {subtitle && <div className="sheet-sub">{subtitle}</div>}
        </div>
        <div className="sheet-grid">
          {actions.map((a) => (
            <button
              key={a.key} className={`sheet-action ${a.danger ? 'danger' : ''}`}
              onClick={() => { onClose(); a.onClick() }}
            >
              <Icon d={a.icon} size={22} />
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ---------------- Toast ---------------- */

let toastTimer: ReturnType<typeof setTimeout> | null = null
export function showToast(setter: (msg: string) => void, msg: string) {
  setter(msg)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => setter(''), 2600)
}

export function Toast({ msg }: { msg: string }) {
  if (!msg) return null
  return <div className="toast">{msg}</div>
}

export { ICONS }
