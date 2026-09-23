import { useEffect, useRef, useState } from 'react'
import * as api from '../../api'
import { convertFileSrc } from '../../api'
import { formatSize, formatTime } from '../../utils'
import { Icon, PATHS } from '../../ui'

interface ViewerProps {
  path: string
  name: string
  share: () => void
  asText: () => void
  toast: (m: string) => void
}

function Err({ msg, retry }: { msg: string; retry: () => void }) {
  return (
    <div className="error-box">
      <div>预览失败</div>
      <div className="err-detail">{msg}</div>
      <button className="btn primary" onClick={retry}>重试</button>
    </div>
  )
}

function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setError('')
    loader().then((d) => alive && setData(d)).catch((e) => alive && setError(String(e)))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, retry: () => setTick((t) => t + 1) }
}

/* ---------------- Markdown ---------------- */

export function MarkdownView({ path }: ViewerProps) {
  const { data, error, retry } = useLoad(() => api.readText(path), [path])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [mods, setMods] = useState<any>(null)
  useEffect(() => {
    let alive = true
    Promise.all([
      import('react-markdown'),
      import('remark-gfm'),
      import('rehype-highlight'),
    ]).then(([rm, gfm, rh]) => {
      if (alive) setMods({ MD: rm.default, gfm: gfm.default, hl: rh.default })
    })
    return () => { alive = false }
  }, [])
  if (error) return <Err msg={error} retry={retry} />
  if (!data) return <div className="hint">加载中…</div>
  if (data.truncated) return <div className="warn-bar">文件过大，Markdown 预览仅支持 8MB 以内</div>
  return (
    <div className="viewer-scroll">
      <div className="md-body">
        {mods ? (
          <mods.MD remarkPlugins={[mods.gfm]} rehypePlugins={[[mods.hl, { detect: true }]]}>
            {data.text}
          </mods.MD>
        ) : (
          <div className="hint">渲染中…</div>
        )}
      </div>
    </div>
  )
}

/* ---------------- HTML ---------------- */

export function HtmlView({ path }: ViewerProps) {
  const { data, error, retry } = useLoad(() => api.readText(path), [path])
  const [srcMode, setSrcMode] = useState(false)
  if (error) return <Err msg={error} retry={retry} />
  if (!data) return <div className="hint">加载中…</div>
  return (
    <div className="html-viewer">
      <div className="viewer-tools">
        <button className="mini-btn" onClick={() => setSrcMode((s) => !s)}>
          {srcMode ? '预览' : '查看源码'}
        </button>
      </div>
      {srcMode ? (
        <pre className="src-view">{data.text}</pre>
      ) : (
        <iframe
          className="html-frame"
          sandbox="allow-scripts"
          srcDoc={data.text}
          title="HTML 预览"
        />
      )}
    </div>
  )
}

/* ---------------- Image ---------------- */

export function ImageView({ path }: ViewerProps) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(0) // 0=适配 1=原始
  useEffect(() => { setLoaded(false); setFailed(false); setZoom(0) }, [path])
  if (failed) return <Err msg="无法解码此图片" retry={() => setFailed(false)} />
  return (
    <div className="img-viewer" onClick={() => setZoom((z) => (z + 1) % 2)}>
      {!loaded && !failed && <div className="hint">加载中…</div>}
      <img
        src={convertFileSrc(path)}
        alt={path}
        className={zoom === 0 ? 'fit' : 'orig'}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
      <div className="img-hint">{zoom === 0 ? '点击切换为原始尺寸' : '点击适配窗口'}</div>
    </div>
  )
}

/* ---------------- PDF ---------------- */

export function PdfView({ path }: ViewerProps) {
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [scaleMode, setScaleMode] = useState<'fit' | number>('fit')
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<import('pdfjs-dist').PDFDocumentProxy | null>(null)
  const taskRef = useRef<{ destroy: () => Promise<void> } | null>(null)
  const renderTask = useRef<{ cancel: () => void } | null>(null)

  useEffect(() => {
    let alive = true
    setReady(false)
    setError('')
    Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
      async ([pdfjs, worker]) => {
        if (!alive) return
        pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default
        try {
          const task = pdfjs.getDocument({ url: convertFileSrc(path) })
          taskRef.current = task
          const doc = await task.promise
          if (!alive) { task.destroy(); return }
          docRef.current = doc
          setNumPages(doc.numPages)
          setPage(1)
          setReady(true)
        } catch (e) {
          if (alive) setError(String(e))
        }
      },
    )
    return () => {
      alive = false
      renderTask.current?.cancel()
      taskRef.current?.destroy().catch(() => {})
      taskRef.current = null
      docRef.current = null
    }
  }, [path])

  useEffect(() => {
    const doc = docRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas || !ready) return
    let alive = true
    ;(async () => {
      try {
        const p = await doc.getPage(page)
        let scale = 1
        if (scaleMode === 'fit') {
          const base = p.getViewport({ scale: 1 })
          scale = ((wrapRef.current?.clientWidth ?? 360) - 16) / base.width
        } else {
          scale = scaleMode
        }
        const dpr = window.devicePixelRatio || 1
        const viewport = p.getViewport({ scale: scale * dpr })
        renderTask.current?.cancel()
        const task = p.render({
          canvas,
          canvasContext: canvas.getContext('2d')!,
          viewport,
        })
        renderTask.current = task
        await task.promise
      } catch (e) {
        if (alive && String(e).indexOf('cancel') === -1) console.warn(e)
      }
    })()
    return () => { alive = false }
  }, [page, scaleMode, ready, path])

  if (error) return <Err msg={error} retry={() => setError('')} />
  return (
    <div className="pdf-viewer">
      <div className="viewer-tools">
        <button className="mini-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
        <span>{ready ? `${page} / ${numPages}` : '…'}</span>
        <button className="mini-btn" disabled={page >= numPages} onClick={() => setPage((p) => p + 1)}>下一页</button>
        <button className="mini-btn" onClick={() => setScaleMode((s) => (s === 'fit' ? 1 : s === 1 ? 1.5 : 'fit'))}>
          {scaleMode === 'fit' ? '适配宽度' : `${scaleMode}x`}
        </button>
      </div>
      <div className="pdf-scroll" ref={wrapRef}>
        <canvas ref={canvasRef} className="pdf-canvas" />
      </div>
    </div>
  )
}

/* ---------------- DOCX ---------------- */

export function DocxView({ path }: ViewerProps) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    Promise.all([
      import('mammoth/mammoth.browser.min.js'),
      fetch(convertFileSrc(path)).then((r) => r.arrayBuffer()),
    ]).then(([mod, buf]) => {
      if (!alive) return
      const mammoth = (mod as { default?: { convertToHtml: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> } }).default
        ?? (mod as unknown as { convertToHtml: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> })
      return mammoth.convertToHtml({ arrayBuffer: buf }).then((r) => {
        if (alive) { setHtml(r.value); setLoading(false) }
      })
    }).catch((e) => {
      if (alive) { setError(String(e)); setLoading(false) }
    })
    return () => { alive = false }
  }, [path, tick])
  if (error) return <Err msg={error} retry={() => setTick((t) => t + 1)} />
  if (loading) return <div className="hint">加载中…</div>
  return <div className="viewer-scroll"><div className="docx-body" dangerouslySetInnerHTML={{ __html: html }} /></div>
}

/* ---------------- XLSX ---------------- */

export function XlsxView({ path }: ViewerProps) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[]>([])
  const [active, setActive] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    Promise.all([
      import('xlsx'),
      fetch(convertFileSrc(path)).then((r) => r.arrayBuffer()),
    ]).then(([XLSX, buf]) => {
      if (!alive) return
      const wb = XLSX.read(buf, { type: 'array' })
      const out = wb.SheetNames.map((name) => {
        const ws = wb.Sheets[name]
        return { name, html: XLSX.utils.sheet_to_html(ws, { editable: false }) }
      })
      setSheets(out)
      setActive(0)
      setLoading(false)
    }).catch((e) => {
      if (alive) { setError(String(e)); setLoading(false) }
    })
    return () => { alive = false }
  }, [path, tick])
  if (error) return <Err msg={error} retry={() => setTick((t) => t + 1)} />
  if (loading) return <div className="hint">加载中…</div>
  return (
    <div className="xlsx-viewer">
      <div className="sheet-tabs">
        {sheets.map((s, i) => (
          <button key={s.name} className={`tab ${i === active ? 'active' : ''}`} onClick={() => setActive(i)}>
            {s.name}
          </button>
        ))}
      </div>
      <div className="viewer-scroll" dangerouslySetInnerHTML={{ __html: sheets[active]?.html ?? '' }} />
    </div>
  )
}

/* ---------------- PPTX ---------------- */

export function PptxView({ path }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    Promise.all([
      import('pptx-preview'),
      fetch(convertFileSrc(path)).then((r) => r.arrayBuffer()),
    ]).then(([{ init }, buf]) => {
      if (!alive || !hostRef.current) return
      const w = Math.min(hostRef.current.clientWidth || 400, 1200)
      const previewer = init(hostRef.current, { width: w, height: (w * 9) / 16 })
      previewer.preview(buf)
      setLoading(false)
    }).catch((e) => {
      if (alive) { setError(String(e)); setLoading(false) }
    })
    return () => { alive = false }
  }, [path, tick])
  if (error) return <Err msg={error} retry={() => setTick((t) => t + 1)} />
  return (
    <div className="pptx-viewer">
      {loading && <div className="hint">加载中…</div>}
      <div ref={hostRef} className="pptx-host" />
    </div>
  )
}

/* ---------------- 音视频 ---------------- */

export function VideoView({ path }: ViewerProps) {
  return (
    <div className="media-viewer">
      <video controls playsInline src={convertFileSrc(path)} className="media" />
      <div className="img-hint">若无法播放，说明 WebView 不支持此编码，可尝试“用系统打开”</div>
    </div>
  )
}

export function AudioView({ path }: ViewerProps) {
  return (
    <div className="media-viewer">
      <div className="media-icon"><Icon d={PATHS.audio} size={64} /></div>
      <audio controls src={convertFileSrc(path)} className="audio" />
    </div>
  )
}

/* ---------------- 二进制/未知 ---------------- */

export function BinaryView({ path, name, share, asText }: ViewerProps) {
  const [meta, setMeta] = useState<{ size: number; modified_ms: number; is_dir: boolean } | null>(null)
  useEffect(() => { api.statPath(path).then(setMeta).catch(() => setMeta(null)) }, [path])
  const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : ''
  return (
    <div className="binary-view">
      <div className="binary-card">
        <div className="binary-ext">{ext || '文件'}</div>
        <div className="binary-name">{name}</div>
        <div className="binary-meta">
          {meta ? `${formatSize(meta.size)} · ${formatTime(meta.modified_ms)}` : ''}
        </div>
        <div className="binary-note">此类型不支持在线预览</div>
        <div className="modal-btns center">
          <button className="btn primary" onClick={share}>用系统打开</button>
          <button className="btn ghost" onClick={asText}>以文本打开</button>
        </div>
      </div>
    </div>
  )
}
