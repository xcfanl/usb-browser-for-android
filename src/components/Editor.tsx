import { useEffect, useRef, useState } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView as EV, keymap } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { undo, redo, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import * as api from '../api'
import { extOf } from '../fileTypes'
import { formatSize } from '../utils'
import { ConfirmDialog, Icon, PATHS } from '../ui'

function langFor(ext: string) {
  switch (ext) {
    case 'md': case 'markdown': case 'mdown': case 'mkd': return markdown()
    case 'html': case 'htm': case 'xhtml': return html()
    case 'css': case 'scss': case 'less': return css()
    case 'js': case 'mjs': case 'cjs': case 'ts': case 'tsx': case 'jsx':
      return javascript({ typescript: ext.startsWith('t'), jsx: /x$/.test(ext) })
    case 'json': return json()
    case 'py': return python()
    case 'xml': case 'svg': case 'xsl': case 'plist': return xml()
    case 'yml': case 'yaml': return yaml()
    case 'sql': return sql()
    default: return undefined
  }
}

function themeExt(fontSize: number) {
  return EV.theme({
    '&': { fontSize: `${fontSize}px`, background: 'transparent', height: '100%' },
    '.cm-scroller': { fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace" },
    '.cm-editor': { height: '100%' },
  })
}

export default function Editor({ path, registerGuard, goBack, toast }: {
  path: string
  registerGuard: (fn: (() => boolean) | null) => void
  goBack: () => void
  toast: (msg: string) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const [encoding, setEncoding] = useState('')
  const [size, setSize] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [confirmBack, setConfirmBack] = useState(false)
  const [saving, setSaving] = useState(false)
  const [fontSize, setFontSize] = useState(15)
  const [status, setStatus] = useState('Ln 1, Col 1')
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const dirtyRef = useRef(false)
  const baselineRef = useRef('')
  const textRef = useRef('')
  const themeComp = useRef(new Compartment())

  useEffect(() => {
    let alive = true
    api.readText(path).then((r) => {
      if (!alive) return
      setText(r.text)
      setEncoding(r.encoding)
      setSize(r.size)
      setTruncated(r.truncated)
    }).catch((e) => {
      if (!alive) return
      toast(`读取失败: ${e}`)
      setText('')
    })
    return () => { alive = false }
  }, [path, toast])

  useEffect(() => {
    if (text === null || viewRef.current || !hostRef.current) return
    baselineRef.current = text
    textRef.current = text
    const updateListener = EV.updateListener.of((u) => {
      if (u.docChanged) {
        textRef.current = u.state.doc.toString()
        dirtyRef.current = textRef.current !== baselineRef.current
        setDirty(dirtyRef.current)
        const pos = u.state.selection.main.head
        const line = u.state.doc.lineAt(pos)
        setStatus(`Ln ${line.number}, Col ${pos - line.from + 1}`)
      }
    })
    const exts = [
      basicSetup,
      oneDark,
      themeComp.current.of(themeExt(fontSize)),
      updateListener,
      keymap.of([indentWithTab]),
      EV.lineWrapping,
    ]
    const lang = langFor(extOf(path))
    if (lang) exts.push(lang)
    const view = new EditorView({
      state: EditorState.create({ doc: text, extensions: exts }),
      parent: hostRef.current,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 仅在首次拿到文本时初始化一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text === null])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeComp.current.reconfigure(themeExt(fontSize)),
    })
  }, [fontSize])

  const save = async () => {
    if (!viewRef.current) return
    setSaving(true)
    try {
      await api.writeText(path, textRef.current)
      baselineRef.current = textRef.current
      dirtyRef.current = false
      setDirty(false)
      toast('已保存')
    } catch (e) {
      toast(`保存失败: ${e}`)
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    registerGuard(() => {
      if (dirtyRef.current) {
        setConfirmBack(true)
        return true
      }
      return false
    })
    return () => registerGuard(null)
  }, [registerGuard])

  if (text === null) return <div className="hint screen-loading">加载中…</div>

  return (
    <div className="editor-screen">
      <header className="topbar">
        <button className="icon-btn" onClick={() => (dirty ? setConfirmBack(true) : goBack())}>
          <Icon d={PATHS.back} />
        </button>
        <div className="editor-title">
          <span className="row-name">{path.split('/').pop()}</span>
          <span className="editor-sub">
            {dirty && <i className="dot" />}
            {encoding} · {formatSize(size)}
          </span>
        </div>
        <button className="icon-btn" onClick={() => setFontSize((f) => Math.max(11, f - 1))}>A-</button>
        <button className="icon-btn" onClick={() => setFontSize((f) => Math.min(28, f + 1))}>A+</button>
        <button className="icon-btn" onClick={save} disabled={saving} aria-label="保存">
          <Icon d={PATHS.save} color={dirty ? 'var(--accent)' : 'currentColor'} />
        </button>
      </header>

      {truncated && (
        <div className="warn-bar">文件超过 8MB，仅加载前 8MB，保存将覆盖超出部分！</div>
      )}

      <div className="editor-wrap">
        <div ref={hostRef} className="cm-host" />
      </div>

      <footer className="editor-status">
        <span>{status}</span>
        <div className="editor-tools">
          <button className="mini-btn" onClick={() => undo(viewRef.current!)}>撤销</button>
          <button className="mini-btn" onClick={() => redo(viewRef.current!)}>重做</button>
        </div>
      </footer>

      {confirmBack && (
        <ConfirmDialog
          title="未保存的修改"
          message="当前文件有未保存的修改，返回将丢失。确定返回吗？"
          danger
          onConfirm={() => {
            dirtyRef.current = false
            setDirty(false)
            setConfirmBack(false)
            goBack()
          }}
          onCancel={() => setConfirmBack(false)}
        />
      )}
    </div>
  )
}
