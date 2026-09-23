import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import Explorer from './components/Explorer'
import Home from './components/Home'
import type { Screen, ViewerKind, Clipboard, Entry, Volume } from './types'
import * as api from './api'
import { useStorageRemoved } from './hooks'
import { classify, MIME_MAP } from './fileTypes'
import { Icon, PATHS, Toast, showToast } from './ui'
import './styles.css'

const Editor = lazy(() => import('./components/Editor'))

const VIEWER_COMPONENTS: Record<
  ViewerKind,
  React.LazyExoticComponent<React.ComponentType<{
    path: string; name: string; share: () => void; asText: () => void; toast: (m: string) => void
  }>>
> = {
  markdown: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.MarkdownView }))),
  html: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.HtmlView }))),
  image: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.ImageView }))),
  pdf: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.PdfView }))),
  docx: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.DocxView }))),
  xlsx: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.XlsxView }))),
  pptx: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.PptxView }))),
  video: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.VideoView }))),
  audio: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.AudioView }))),
  text: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.BinaryView }))),
  binary: lazy(() => import('./components/viewers/Viewers').then((m) => ({ default: m.BinaryView }))),
}

export default function App() {
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [volsLoading, setVolsLoading] = useState(true)
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [stack, setStack] = useState<Screen[]>([])
  const [clipboard, setClipboard] = useState<Clipboard | null>(null)
  const [toastMsg, setToastMsg] = useState('')
  const depthRef = useRef(0)
  const guardRef = useRef<(() => boolean) | null>(null)
  const navRef = useRef<{ apply: (dirs: string[]) => void; currentDirs: () => string[] } | null>(null)
  const initialDirsRef = useRef<string[] | null>(null)

  const toast = useCallback((m: string) => showToast(setToastMsg, m), [])

  /* 卷列表 */
  const refreshVolumes = useCallback(() => {
    setVolsLoading(true)
    api.getVolumes().then((v) => { setVolumes(v); setVolsLoading(false) }).catch(() => setVolsLoading(false))
  }, [])
  useEffect(() => { refreshVolumes() }, [refreshVolumes])

  /* U 盘插拔：Rust 侧轮询器发出事件，卷列表统一在此刷新 */
  useEffect(() => {
    let un: (() => void) | undefined
    let alive = true
    api.onVolumesChanged(() => refreshVolumes()).then((u) => {
      if (alive) un = u
      else u()
    })
    return () => {
      alive = false
      un?.()
    }
  }, [refreshVolumes])

  /* 权限检测：启动 + 回到前台时；回前台同时刷新卷列表（后台事件可能丢失） */
  useEffect(() => {
    const check = () =>
      api.checkAllFilesAccess().then(setAllowed).catch(() => setAllowed(true))
    check()
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        check()
        refreshVolumes()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refreshVolumes])

  /* Android 返回键 <-> 历史栈（d: 屏幕深度，dirs: 当前位置目录链） */
  useEffect(() => {
    history.replaceState({ d: 0 }, '')
    const onPop = (e: PopStateEvent) => {
      const st = (e.state ?? {}) as { d?: number; dirs?: string[] }
      const target = typeof st.d === 'number' ? st.d : 0
      if (target >= depthRef.current) {
        if (target === depthRef.current && guardRef.current?.()) {
          const cur = navRef.current?.currentDirs()
          history.pushState(cur ? { d: target, dirs: cur } : { d: target }, '')
          return
        }
        depthRef.current = target
        if (Array.isArray(st.dirs)) navRef.current?.apply(st.dirs)
        return
      }
      if (guardRef.current?.()) {
        const cur = navRef.current?.currentDirs()
        history.pushState(cur ? { d: depthRef.current, dirs: cur } : { d: depthRef.current }, '')
        return
      }
      depthRef.current = target
      initialDirsRef.current = Array.isArray(st.dirs) ? st.dirs : null
      setStack((s) => s.slice(0, target))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const pushScreen = useCallback((s: Screen) => {
    initialDirsRef.current = null
    setStack((st) => [...st, s])
    depthRef.current += 1
    history.pushState({ d: depthRef.current }, '')
  }, [])
  const goBack = useCallback(() => {
    if (depthRef.current > 0) history.back()
  }, [])
  const registerGuard = useCallback((fn: (() => boolean) | null) => {
    guardRef.current = fn
  }, [])
  const registerNav = useCallback(
    (n: { apply: (dirs: string[]) => void; currentDirs: () => string[] } | null) => {
      navRef.current = n
    },
    [],
  )
  const pushDirNav = useCallback((dirs: string[]) => {
    history.pushState({ d: depthRef.current, dirs }, '')
  }, [])
  const replaceDirNav = useCallback((dirs: string[]) => {
    history.replaceState({ d: depthRef.current, dirs }, '')
  }, [])

  const pickVolume = useCallback((v: Volume) => {
    initialDirsRef.current = null
    setStack((st) => [...st, { t: 'explorer', root: v.path }])
    depthRef.current += 1
    history.pushState({ d: depthRef.current, dirs: [v.path] }, '')
  }, [])

  const openFile = useCallback((entry: Entry, forceKind?: 'text') => {
    if (forceKind === 'text') {
      pushScreen({ t: 'editor', path: entry.path })
      return
    }
    const kind = classify(entry)
    if (kind === 'folder') return
    if (kind === 'text') {
      pushScreen({ t: 'editor', path: entry.path })
      return
    }
    pushScreen({ t: 'viewer', kind, path: entry.path, name: entry.name })
  }, [pushScreen])

  const shareFile = useCallback((path: string, ext: string) => {
    const mime = MIME_MAP[ext.toLowerCase()] ?? '*/*'
    api.openWithSystem(path, mime).catch(async () => {
      try {
        const { openPath } = await import('@tauri-apps/plugin-opener')
        await openPath(path)
      } catch (e) {
        toast(`打开失败: ${e}`)
      }
    })
  }, [toast])

  /* 权限引导页 */
  if (allowed === false) {
    return (
      <div className="perm-screen">
        <div className="perm-card">
          <div className="perm-icon"><Icon d={PATHS.usb} size={56} /></div>
          <h1>需要“所有文件访问”权限</h1>
          <p>
            本应用用于浏览手机本机存储和 USB 外接存储设备，需要「所有文件访问权限」才能读取文件列表与内容。
          </p>
          <ol>
            <li>点击下方按钮打开系统设置</li>
            <li>找到本应用并允许「所有文件访问」</li>
            <li>返回本应用即可自动继续</li>
          </ol>
          <button
            className="btn primary big"
            onClick={() => { api.requestAllFilesAccess(); toast('请在设置中授予权限后返回') }}
          >
            去开启权限
          </button>
          <button className="btn ghost" onClick={() => setAllowed(true)}>暂不授权，先看看</button>
        </div>
        <Toast msg={toastMsg} />
      </div>
    )
  }

  const top = stack[stack.length - 1]

  return (
    <div className="app">
      {top === undefined ? (
        <Home
          volumes={volumes}
          loading={volsLoading}
          onPick={pickVolume}
          onRefresh={refreshVolumes}
        />
      ) : top.t === 'explorer' ? (
        <Explorer
          root={top.root}
          initialDirs={initialDirsRef.current ?? undefined}
          volumes={volumes}
          clipboard={clipboard}
          setClipboard={setClipboard}
          onOpenFile={openFile}
          onExit={goBack}
          pushDirNav={pushDirNav}
          replaceDirNav={replaceDirNav}
          registerNav={registerNav}
          registerGuard={registerGuard}
          toast={toast}
        />
      ) : top.t === 'editor' ? (
        <Suspense fallback={<div className="hint screen-loading">加载中…</div>}>
          <Editor path={top.path} registerGuard={registerGuard} goBack={goBack} toast={toast} />
        </Suspense>
      ) : top.t === 'viewer' ? (
        <ViewerHost
          kind={top.kind}
          path={top.path}
          name={top.name}
          goBack={goBack}
          toast={toast}
          shareFile={shareFile}
          asText={() => pushScreen({ t: 'editor', path: top.path })}
        />
      ) : null}
      <Toast msg={toastMsg} />
    </div>
  )
}

function ViewerHost({ kind, path, name, goBack, toast, shareFile, asText }: {
  kind: ViewerKind; path: string; name: string
  goBack: () => void; toast: (m: string) => void
  shareFile: (path: string, ext: string) => void
  asText: () => void
}) {
  const Comp = VIEWER_COMPONENTS[kind] ?? VIEWER_COMPONENTS.binary
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  /* 预览期间 U 盘被拔出：提示并退回 */
  useStorageRemoved(path, () => {
    toast('文件所在存储卷已移除')
    goBack()
  })
  return (
    <div className="viewer-screen">
      <header className="topbar">
        <button className="icon-btn" onClick={goBack} aria-label="返回">
          <Icon d={PATHS.back} />
        </button>
        <div className="editor-title">
          <span className="row-name">{name}</span>
          <span className="editor-sub">{kind.toUpperCase()} 预览</span>
        </div>
        <button className="icon-btn" aria-label="用系统打开" onClick={() => shareFile(path, ext)}>
          <Icon d={PATHS.more} />
        </button>
      </header>
      <div className="viewer-body">
        <Suspense fallback={<div className="hint">加载预览组件…</div>}>
          <Comp
            path={path} name={name} toast={toast}
            share={() => shareFile(path, ext)} asText={asText}
          />
        </Suspense>
      </div>
    </div>
  )
}
