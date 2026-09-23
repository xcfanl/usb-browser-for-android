import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Clipboard, Entry, Volume } from '../types'
import * as api from '../api'
import { classify, iconFor, KIND_COLORS, mimeFor } from '../fileTypes'
import { basename, dirname, formatSize, formatTime, joinPath, sortEntries, type SortBy } from '../utils'
import { BottomSheet, ConfirmDialog, Icon, Modal, PATHS, PromptDialog, type SheetAction } from '../ui'

interface Props {
  root: string
  initialDirs?: string[]
  volumes: Volume[]
  clipboard: Clipboard | null
  setClipboard: (c: Clipboard | null) => void
  onOpenFile: (entry: Entry, forceKind?: 'text') => void
  onExit: () => void
  pushDirNav: (dirs: string[]) => void
  replaceDirNav: (dirs: string[]) => void
  registerNav: (n: { apply: (dirs: string[]) => void; currentDirs: () => string[] } | null) => void
  registerGuard: (fn: (() => boolean) | null) => void
  toast: (msg: string) => void
  refreshVolumes: () => void
}

type Dialog =
  | null
  | { d: 'newFolder' | 'newFile' | 'rename'; target?: Entry }
  | { d: 'delete'; targets: Entry[] }
  | { d: 'info'; target: Entry }

export default function Explorer(props: Props) {
  const {
    root: rootProp, initialDirs, volumes, clipboard, setClipboard, onOpenFile, onExit,
    pushDirNav, replaceDirNav, registerNav, registerGuard, toast, refreshVolumes,
  } = props
  const initDirs = initialDirs ?? []
  const [root, setRoot] = useState<string>(rootProp)
  const [dirStack, setDirStack] = useState<string[]>(initDirs.slice(0, -1))
  const [dir, setDir] = useState<string>(initDirs.length ? initDirs[initDirs.length - 1] : rootProp)
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [sortDesc, setSortDesc] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchHits, setSearchHits] = useState<Entry[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [sheetFor, setSheetFor] = useState<Entry | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const selectionMode = selected.size > 0
  const [sortMenu, setSortMenu] = useState(false)
  const [moreMenu, setMoreMenu] = useState(false)
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressClick = useRef(false)

  const visible = useMemo(() => {
    const list = showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))
    return sortEntries(list, sortBy, sortDesc)
  }, [entries, showHidden, sortBy, sortDesc])

  const load = useCallback(async (p: string) => {
    setLoading(true)
    setError('')
    try {
      setEntries(await api.listDir(p))
    } catch (e) {
      setEntries([])
      setError(String(e).replace(/^Error:\s*/, '') || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(dir) }, [dir, load])

  // USB 卷变化：刷新卷列表；当前目录失效则退回主页
  useEffect(() => {
    let un: (() => void) | undefined
    api.onVolumesChanged(() => {
      refreshVolumes()
      if (dir.startsWith('/storage')) {
        api.statPath(dir).catch(() => {
          toast('当前目录的存储卷已移除')
          onExit()
        })
      }
    }).then((u) => (un = u))
    return () => un?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, refreshVolumes, onExit])

  /* 返回键弹出目录栈：popstate 携带目标位置完整目录链 */
  useEffect(() => {
    registerNav({
      apply: (dirs: string[]) => {
        setSelected(new Set())
        setSheetFor(null)
        setDirStack(dirs.slice(0, -1))
        setDir(dirs.length ? dirs[dirs.length - 1] : root)
      },
      currentDirs: () => [...dirStack, dir],
    })
    return () => registerNav(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirStack, dir, root, registerNav])

  /* 多选模式下，返回键先退出多选 */
  useEffect(() => {
    if (!selectionMode) return
    registerGuard(() => {
      setSelected(new Set())
      return true
    })
    return () => registerGuard(null)
  }, [selectionMode, registerGuard])

  const navigate = (p: string, pushHistory = true) => {
    setSelected(new Set())
    setSheetFor(null)
    if (pushHistory) {
      setDirStack([...dirStack, dir])
      pushDirNav([...dirStack, dir, p])
    }
    setDir(p)
  }

  const goBack = () => {
    setSelected(new Set())
    if (searchHits) { setSearchHits(null); setQuery(''); return }
    if (dirStack.length) { history.back(); return }
    onExit()
  }

  const switchRoot = (p: string) => {
    setRoot(p); setDirStack([]); setDir(p)
    replaceDirNav([])
  }

  const crumbs = useMemo(() => {
    const rel = dir.startsWith(root) ? dir.slice(root.length) : dir
    const segs = rel.split('/').filter(Boolean)
    const items: { name: string; path: string }[] = [{ name: basename(root) || root, path: root }]
    let acc = root === '/' ? '' : root
    for (const s of segs) {
      acc = acc === '' ? `/${s}` : `${acc}/${s}`
      items.push({ name: s, path: acc })
    }
    return items
  }, [dir, root])

  const openEntry = (e: Entry) => {
    if (e.is_dir) navigate(e.path)
    else onOpenFile(e)
  }

  /* ------- 操作 ------- */

  const afterChange = (msg: string) => { toast(msg); load(dir) }

  const doDelete = async (targets: Entry[]) => {
    const errs: string[] = []
    for (const t of targets) {
      try { await api.deletePath(t.path) } catch (e) { errs.push(`${t.name}: ${e}`) }
    }
    if (errs.length) toast(`删除失败: ${errs[0]}`)
    else afterChange(targets.length > 1 ? `已删除 ${targets.length} 项` : `已删除 ${targets[0].name}`)
  }

  const doRename = async (target: Entry, newName: string) => {
    try {
      await api.renamePath(target.path, joinPath(dirname(target.path), newName))
      afterChange(`已重命名为 ${newName}`)
    } catch (e) { toast(`重命名失败: ${e}`) }
  }

  const doNewFolder = async (name: string) => {
    try { await api.createDir(joinPath(dir, name)); afterChange(`已创建文件夹 ${name}`) }
    catch (e) { toast(`创建失败: ${e}`) }
  }

  const doNewFile = async (name: string) => {
    try {
      await api.writeText(joinPath(dir, name), '')
      afterChange(`已创建文件 ${name}`)
      onOpenFile({ name, path: joinPath(dir, name), is_dir: false, is_symlink: false, size: 0, modified_ms: Date.now(), ext: '' }, 'text')
    } catch (e) { toast(`创建失败: ${e}`) }
  }

  const doPaste = async () => {
    if (!clipboard) return
    const errs = clipboard.mode === 'copy'
      ? await api.copyPaths(clipboard.items, dir)
      : await api.movePaths(clipboard.items, dir)
    const real = errs.filter((e) => e && e !== 'undefined')
    if (real.length) toast(`操作失败: ${real[0]}`)
    else afterChange(`${clipboard.mode === 'copy' ? '复制' : '移动'}了 ${clipboard.items.length} 项`)
    if (clipboard.mode === 'cut') setClipboard(null)
  }

  const setClip = (mode: 'copy' | 'cut', items: Entry[]) => {
    setClipboard({ mode, items: items.map((i) => i.path) })
    toast(`${mode === 'copy' ? '复制' : '剪切'}了 ${items.length} 项`)
    setSelected(new Set())
  }

  const share = (e: Entry) => {
    api.openWithSystem(e.path, mimeFor(e)).catch((err) => toast(`打开失败: ${err}`))
  }

  /* ------- 选择 ------- */

  const toggleSelect = (e: Entry) => {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(e.path)) n.delete(e.path)
      else n.add(e.path)
      return n
    })
  }
  const selectAll = () => setSelected(new Set(visible.map((e) => e.path)))
  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.path)),
    [entries, selected],
  )

  /* ------- 手势 ------- */

  const startLongPress = (e: Entry) => {
    longPress.current = setTimeout(() => {
      suppressClick.current = true
      longPress.current = null
      if (navigator.vibrate) navigator.vibrate(10)
      if (selectionMode) toggleSelect(e)
      else setSelected(new Set([e.path]))
    }, 400)
  }
  const cancelLongPress = () => {
    if (longPress.current) { clearTimeout(longPress.current); longPress.current = null }
  }
  const rowClick = (e: Entry) => {
    if (suppressClick.current) { suppressClick.current = false; return }
    if (selectionMode) { toggleSelect(e); return }
    openEntry(e)
  }

  /* ------- 搜索 ------- */

  useEffect(() => {
    if (!searchOpen) return
    const q = query.trim()
    if (!q) { setSearchHits(null); return }
    const t = setTimeout(async () => {
      try { setSearchHits(await api.search(dir, q)) } catch { setSearchHits([]) }
    }, 350)
    return () => clearTimeout(t)
  }, [query, searchOpen, dir])

  const doPasteRef = useRef<(() => Promise<void>) | null>(null)
  doPasteRef.current = doPaste

  /* ------- 渲染 ------- */

  const sheetActions: SheetAction[] = useMemo(() => {
    const e = sheetFor
    if (!e) return []
    const acts: SheetAction[] = []
    acts.push({ key: 'open', label: '打开', icon: PATHS.open, onClick: () => openEntry(e) })
    acts.push({ key: 'select', label: '加入多选', icon: PATHS.check, onClick: () => toggleSelect(e) })
    if (e.is_dir) {
      acts.push({ key: 'pasteInto', label: '粘贴到此处', icon: PATHS.copy, onClick: () => { navigate(e.path, false); setTimeout(() => doPasteRef.current?.(), 50) } })
    }
    acts.push({ key: 'copy', label: '复制', icon: PATHS.copy, onClick: () => setClip('copy', [e]) })
    acts.push({ key: 'cut', label: '剪切', icon: PATHS.cut, onClick: () => setClip('cut', [e]) })
    acts.push({ key: 'rename', label: '重命名', icon: PATHS.rename, onClick: () => setDialog({ d: 'rename', target: e }) })
    acts.push({ key: 'delete', label: '删除', icon: PATHS.trash, danger: true, onClick: () => setDialog({ d: 'delete', targets: [e] }) })
    acts.push({ key: 'info', label: '属性', icon: PATHS.info, onClick: () => setDialog({ d: 'info', target: e }) })
    if (!e.is_dir) {
      acts.push({ key: 'share', label: '用系统打开', icon: PATHS.more, onClick: () => share(e) })
      acts.push({ key: 'asText', label: '以文本打开', icon: PATHS.code, onClick: () => onOpenFile(e, 'text') })
    }
    return acts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetFor, clipboard, selected])

  const selBarActions = (
    <>
      <button className="act" onClick={() => setClip('copy', selectedEntries)}><Icon d={PATHS.copy} />复制</button>
      <button className="act" onClick={() => setClip('cut', selectedEntries)}><Icon d={PATHS.cut} />剪切</button>
      <button className="act danger" onClick={() => setDialog({ d: 'delete', targets: selectedEntries })}><Icon d={PATHS.trash} />删除</button>
      {selectedEntries.length === 1 && (
        <button className="act" onClick={() => setDialog({ d: 'rename', target: selectedEntries[0] })}><Icon d={PATHS.rename} />重命名</button>
      )}
      <button className="act" onClick={selectAll}><Icon d={PATHS.check} />全选</button>
      <button className="act" onClick={() => setSelected(new Set())}><Icon d={PATHS.close} />取消</button>
    </>
  )

  return (
    <div className="explorer">
      {/* 顶栏 */}
      <header className="topbar">
        {selectionMode ? (
          <>
            <button className="icon-btn" onClick={() => setSelected(new Set())} aria-label="退出多选">
              <Icon d={PATHS.close} />
            </button>
            <div className="editor-title">
              <span className="row-name">已选 {selected.size} 项</span>
            </div>
          </>
        ) : (
          <>
            <button className="icon-btn" onClick={() => setDrawerOpen(true)} aria-label="存储源">
              <Icon d={PATHS.menu} />
            </button>
            <button className="icon-btn" onClick={goBack} aria-label="返回"><Icon d={PATHS.back} /></button>
            {searchOpen ? (
              <input
                autoFocus className="search-input" value={query}
                placeholder={`在 ${basename(dir) || dir} 中搜索…`}
                onChange={(e) => setQuery(e.target.value)}
              />
            ) : (
              <div className="crumbs">
                {crumbs.map((c, i) => (
                  <span key={c.path} className="crumb-wrap">
                    {i > 0 && <span className="crumb-sep">/</span>}
                    <button className="crumb" onClick={() => navigate(c.path)}>{c.name}</button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        {!selectionMode && (
          <button className="icon-btn" onClick={() => { setSearchOpen((s) => !s); setQuery(''); setSearchHits(null) }}>
            <Icon d={searchOpen ? PATHS.close : PATHS.search} />
          </button>
        )}
        {!selectionMode && <button className="icon-btn" onClick={() => setSortMenu(true)}><Icon d={PATHS.sort} /></button>}
        <button className="icon-btn" onClick={() => setMoreMenu(true)}><Icon d={PATHS.more} /></button>
      </header>

      {/* 存储源抽屉 */}
      {drawerOpen && (
        <div className="drawer-mask" onClick={() => setDrawerOpen(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-title">存储位置</div>
            {volumes.map((v) => {
              const pct = v.total_bytes > 0 ? Math.round(((v.total_bytes - v.available_bytes) / v.total_bytes) * 100) : 0
              return (
                <button
                  key={v.path}
                  className={`drawer-item ${v.path === root ? 'active' : ''}`}
                  onClick={() => {
                    switchRoot(v.path)
                    setDrawerOpen(false)
                  }}
                >
                  <div className="drawer-item-top">
                    <Icon d={v.kind === 'removable' ? PATHS.usb : PATHS.home} size={18} />
                    <span className="drawer-name">{v.name}</span>
                  </div>
                  <div className="usage-bar"><div style={{ width: `${pct}%` }} /></div>
                  <div className="usage-text">
                    {v.total_bytes > 0 ? `${formatSize(v.available_bytes)} 可用 / 共 ${formatSize(v.total_bytes)}` : ''}
                  </div>
                </button>
              )
            })}
            {!volumes.length && <div className="drawer-empty">未检测到可用存储</div>}
          </aside>
        </div>
      )}

      {/* 内容区 */}
      <main
        className={`list ${selectionMode ? 'selecting' : ''}`}
        onClick={() => { if (selectionMode) setSelected(new Set()) }}
      >
        {loading && <div className="hint">加载中…</div>}
        {error && !loading && (
          <div className="error-box">
            <div>{error}</div>
            <div className="error-actions">
              <button className="btn primary" onClick={() => load(dir)}>重试</button>
              <button className="btn ghost" onClick={() => switchRoot(rootProp)}>回到根目录</button>
            </div>
          </div>
        )}
        {!loading && !error && searchHits && (
          <div className="search-note">在当前目录树中找到 {searchHits.length} 项</div>
        )}
        {!loading && !error && !(searchHits ?? visible).length && (
          <div className="hint">{searchHits ? '没有匹配的结果' : '空目录'}</div>
        )}
        {(searchHits ?? visible).map((e) => {
          const kind = classify(e)
          const isSel = selected.has(e.path)
          return (
            <div
              key={e.path}
              className={`row ${isSel ? 'selected' : ''}`}
              onPointerDown={(ev) => { if (ev.pointerType === 'touch') startLongPress(e) }}
              onPointerUp={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onClick={(ev) => { ev.stopPropagation(); rowClick(e) }}
              onContextMenu={(ev) => { ev.preventDefault(); suppressClick.current = true; setSheetFor(e) }}
            >
              <span className={`row-check ${isSel ? 'on' : ''}`}>
                {isSel ? <Icon d={PATHS.check} size={14} /> : null}
              </span>
              <span
                className="row-icon"
                style={{ background: `${KIND_COLORS[kind]}22`, color: KIND_COLORS[kind] }}
              >
                <Icon d={iconFor(e, kind)} size={20} />
              </span>
              <div className="row-main">
                <div className="row-name">
                  {e.name}
                  {e.is_symlink && <span className="tag">链接</span>}
                </div>
                <div className="row-meta">
                  {e.is_dir ? '文件夹' : formatSize(e.size)} · {formatTime(e.modified_ms)}
                  {searchHits && <span className="row-path"> · {dirname(e.path)}</span>}
                </div>
              </div>
              <button
                className="icon-btn"
                onClick={(ev) => { ev.stopPropagation(); suppressClick.current = true; setSheetFor(e) }}
                aria-label="更多"
              >
                <Icon d={PATHS.more} size={18} />
              </button>
            </div>
          )
        })}
      </main>

      {/* 底部操作条 */}
      {selectionMode && <footer className="actionbar">{selBarActions}</footer>}

      {/* 悬浮粘贴按钮 */}
      {clipboard && !selectionMode && (
        <button className="fab" onClick={doPaste}>
          <Icon d={clipboard.mode === 'copy' ? PATHS.copy : PATHS.cut} size={20} />
          粘贴 {clipboard.items.length} 项
        </button>
      )}

      {/* 排序菜单 */}
      {sortMenu && (
        <Modal title="排序方式" onClose={() => setSortMenu(false)}>
          <div className="opt-list">
            {([['name', '名称'], ['size', '大小'], ['time', '修改时间']] as const).map(([k, label]) => (
              <button
                key={k}
                className={`opt ${sortBy === k ? 'active' : ''}`}
                onClick={() => { setSortBy(k); setSortMenu(false) }}
              >
                {label}{sortBy === k ? (sortDesc ? ' ↓' : ' ↑') : ''}
              </button>
            ))}
          </div>
          <div className="modal-btns">
            <button className="btn ghost" onClick={() => { setSortDesc((d) => !d); setSortMenu(false) }}>
              反转方向（当前{sortDesc ? '降序' : '升序'}）
            </button>
          </div>
        </Modal>
      )}

      {/* 更多菜单 */}
      {moreMenu && (
        <Modal title="更多" onClose={() => setMoreMenu(false)}>
          <div className="opt-list">
            <button className="opt" onClick={() => { setMoreMenu(false); load(dir) }}>
              <Icon d={PATHS.refresh} size={18} /> 刷新
            </button>
            <button className="opt" onClick={() => { setMoreMenu(false); setShowHidden((s) => !s) }}>
              <Icon d={PATHS.eye} size={18} /> {showHidden ? '隐藏' : '显示'}隐藏文件
            </button>
            <button className="opt" onClick={() => { setMoreMenu(false); setDialog({ d: 'newFolder' }) }}>
              <Icon d={PATHS.folder} size={18} /> 新建文件夹
            </button>
            <button className="opt" onClick={() => { setMoreMenu(false); setDialog({ d: 'newFile' }) }}>
              <Icon d={PATHS.file} size={18} /> 新建文本文件
            </button>
            <button className="opt" onClick={() => { setMoreMenu(false); selectAll() }}>
              <Icon d={PATHS.check} size={18} /> 全选
            </button>
          </div>
        </Modal>
      )}

      {/* 单项操作 sheet */}
      {sheetFor && (
        <BottomSheet
          title={sheetFor.name}
          subtitle={sheetFor.is_dir ? '文件夹' : formatSize(sheetFor.size)}
          actions={sheetActions}
          onClose={() => setSheetFor(null)}
        />
      )}

      {/* 对话框 */}
      {dialog?.d === 'newFolder' && (
        <PromptDialog
          title="新建文件夹" placeholder="文件夹名称"
          onConfirm={(v) => { setDialog(null); doNewFolder(v) }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.d === 'newFile' && (
        <PromptDialog
          title="新建文本文件" placeholder="例如 notes.txt"
          onConfirm={(v) => { setDialog(null); doNewFile(v) }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.d === 'rename' && dialog.target && (
        <PromptDialog
          title="重命名" initial={dialog.target.name}
          onConfirm={(v) => { setDialog(null); doRename(dialog.target!, v) }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.d === 'delete' && (
        <ConfirmDialog
          title="删除确认" danger
          message={`确定删除 ${dialog.targets.length === 1 ? dialog.targets[0].name : `${dialog.targets.length} 项`}？此操作不可恢复。`}
          onConfirm={() => { const t = dialog.targets; setDialog(null); doDelete(t) }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.d === 'info' && dialog.target && (
        <Modal title="属性" onClose={() => setDialog(null)}>
          <div className="info-rows">
            <div><span>名称</span><b>{dialog.target.name}</b></div>
            <div><span>路径</span><b>{dialog.target.path}</b></div>
            <div><span>类型</span><b>{dialog.target.is_dir ? '文件夹' : classify(dialog.target)}</b></div>
            <div><span>大小</span><b>{dialog.target.is_dir ? '-' : formatSize(dialog.target.size)}</b></div>
            <div><span>修改时间</span><b>{formatTime(dialog.target.modified_ms)}</b></div>
          </div>
          <div className="modal-btns">
            <button className="btn ghost" onClick={() => setDialog(null)}>关闭</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
