import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { version as harnessVersion } from '../../../package.json'
import {
  Archive,
  ArchiveRestore,
  Blocks,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CirclePlus,
  Clock3,
  FolderGit2,
  LayoutList,
  ListTree,
  LoaderCircle,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react'
import type {
  Badge,
  NavigationLayout,
  Thread,
  ThreadSort,
  ThreadUiState,
  Workspace,
  WorkspaceSort,
} from '../../core/domain/codex'
import { isActive, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, sortThreads, sortWorkspacesByRecentThread } from '../../core/domain/codex'
import { relativeTime, truncate } from '../../core/domain/format'
import harnessDevIcon from '../../../icon/codex-harness-dev.svg'
import harnessIcon from '../../../icon/codex-harness.svg'
import { resolveThreadBadge } from './threadBadge'
import { visibleThreadOrder, visibleThreads } from './visibleThreads'

interface SidebarProps {
  workspaces: Workspace[]
  threads: Thread[]
  threadRoots: Record<string, string | null>
  threadStates: Record<string, ThreadUiState>
  selectedThreadId: string | null
  viewMode: 'active' | 'archived'
  navigationLayout: NavigationLayout
  threadSort: ThreadSort
  workspaceSort: WorkspaceSort
  manualThreadOrder: string[]
  sidebarWidth: number
  sidebarCollapsed: boolean
  creatingThread: boolean
  archivingOldThreads: boolean
  onSelectThread: (threadId: string) => void
  onSelectWorkspace: (root: string) => void
  onArchiveOldThreads: () => void
  onNewThread: () => void
  onSearch: (term: string) => void
  onRefresh: () => void
  onViewMode: (mode: 'active' | 'archived') => void
  onNavigationLayout: (layout: NavigationLayout) => void
  onThreadSort: (sort: ThreadSort) => void
  onWorkspaceSort: (sort: WorkspaceSort) => void
  onManualThreadOrder: (order: string[]) => void
  onSidebarWidth: (width: number) => void
  onOpenSettings: () => void
  onOpenPlugins: () => void
  onVisibleThreadOrder: (threadIds: string[]) => void
}

export function Sidebar({
  workspaces,
  threads,
  threadRoots,
  threadStates,
  selectedThreadId,
  viewMode,
  navigationLayout,
  threadSort,
  workspaceSort,
  manualThreadOrder,
  sidebarWidth,
  sidebarCollapsed,
  creatingThread,
  archivingOldThreads,
  onSelectThread,
  onSelectWorkspace,
  onArchiveOldThreads,
  onNewThread,
  onSearch,
  onRefresh,
  onViewMode,
  onNavigationLayout,
  onThreadSort,
  onWorkspaceSort,
  onManualThreadOrder,
  onSidebarWidth,
  onOpenSettings,
  onOpenPlugins,
  onVisibleThreadOrder,
}: SidebarProps) {
  const isDevelopmentFlavor = import.meta.env.MODE === 'dev'
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [highlightedWorkspaceRoot, setHighlightedWorkspaceRoot] = useState<string | null>(null)
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [previewWidth, setPreviewWidth] = useState<number | null>(null)
  const [dragPreviewOrder, setDragPreviewOrder] = useState<string[] | null>(null)
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null)
  const [threadDrop, setThreadDrop] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  const onSearchRef = useRef(onSearch)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchStarted = useRef(false)
  const resizeStart = useRef<{ clientX: number; width: number } | null>(null)
  const resizedWidth = useRef<number | null>(null)
  const threadDrag = useRef<{ id: string; groupKey: string; pointerId: number; startX: number; startY: number; moved: boolean; preview: string[] | null } | null>(null)
  const suppressThreadClick = useRef(false)

  useEffect(() => {
    onSearchRef.current = onSearch
  }, [onSearch])

  useEffect(() => {
    if (!searchOpen) return
    searchInputRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    // Do not re-query after every sidebar re-render. The initial session list is already
    // loaded by the Harness bootstrap; later changes are genuine user searches only.
    if (!searchStarted.current) {
      searchStarted.current = true
      return undefined
    }
    const timeout = window.setTimeout(() => onSearchRef.current(query), 180)
    return () => window.clearTimeout(timeout)
  }, [query])

  useEffect(() => {
    const clearWorkspaceHighlight = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.workspace-row:not(.static)')) return
      setHighlightedWorkspaceRoot(null)
    }
    window.addEventListener('pointerdown', clearWorkspaceHighlight)
    return () => window.removeEventListener('pointerdown', clearWorkspaceHighlight)
  }, [])

  useEffect(() => {
    if (!resizing) return undefined

    const resize = (event: PointerEvent) => {
      const start = resizeStart.current
      if (!start) return
      const width = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, start.width + event.clientX - start.clientX))
      resizedWidth.current = width
      setPreviewWidth(width)
    }
    const finishResize = () => {
      const width = resizedWidth.current
      resizeStart.current = null
      resizedWidth.current = null
      setPreviewWidth(null)
      setResizing(false)
      if (width !== null) onSidebarWidth(width)
    }

    document.body.classList.add('sidebar-resizing')
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', finishResize)
    window.addEventListener('pointercancel', finishResize)
    return () => {
      document.body.classList.remove('sidebar-resizing')
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', finishResize)
      window.removeEventListener('pointercancel', finishResize)
    }
  }, [onSidebarWidth, resizing])

  const orderedThreads = useMemo(
    () => sortThreads(threads, threadSort, dragPreviewOrder ?? manualThreadOrder),
    [dragPreviewOrder, manualThreadOrder, threadSort, threads],
  )

  const orderedWorkspaces = useMemo(
    () => workspaceSort === 'recent'
      ? sortWorkspacesByRecentThread(workspaces, threads, threadRoots)
      : workspaces,
    [threadRoots, threads, workspaceSort, workspaces],
  )

  const grouped = useMemo(() => {
    const byRoot = new Map<string, Thread[]>()
    const unsorted: Thread[] = []
    const roots = new Set(orderedWorkspaces.map((workspace) => workspace.root))
    for (const thread of orderedThreads) {
      const root = threadRoots[thread.id]
      if (root && roots.has(root)) byRoot.set(root, [...(byRoot.get(root) ?? []), thread])
      else unsorted.push(thread)
    }
    return { byRoot, unsorted }
  }, [orderedThreads, orderedWorkspaces, threadRoots])

  const allWorkspacesExpanded = orderedWorkspaces.length > 0 && orderedWorkspaces.every((workspace) => expanded[workspace.root] ?? true)
  const visibleThreadIds = useMemo(() => visibleThreadOrder({
    layout: navigationLayout,
    orderedThreads,
    orderedWorkspaceRoots: orderedWorkspaces.map((workspace) => workspace.root),
    groupedByRoot: grouped.byRoot,
    unsorted: grouped.unsorted,
    expanded,
    visibleCounts,
  }), [expanded, grouped, navigationLayout, orderedThreads, orderedWorkspaces, visibleCounts])

  useEffect(() => onVisibleThreadOrder(visibleThreadIds), [onVisibleThreadOrder, visibleThreadIds])

  const toggleAllWorkspaces = () => {
    const nextValue = !allWorkspacesExpanded
    setExpanded(Object.fromEntries(orderedWorkspaces.map((workspace) => [workspace.root, nextValue])))
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeStart.current = { clientX: event.clientX, width: sidebarWidth }
    resizedWidth.current = sidebarWidth
    setPreviewWidth(sidebarWidth)
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
  }

  const displayedSidebarWidth = previewWidth ?? sidebarWidth
  const sectionLabel = navigationLayout === 'workspace'
    ? workspaceSort === 'recent' ? '最近工作区' : '工作区'
    : '会话'

  const closeSearch = () => {
    setQuery('')
    setSearchOpen(false)
  }

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onSidebarWidth(sidebarWidth - step)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onSidebarWidth(sidebarWidth + step)
    } else if (event.key === 'Home') {
      event.preventDefault()
      onSidebarWidth(MIN_SIDEBAR_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      onSidebarWidth(MAX_SIDEBAR_WIDTH)
    }
  }

  const startThreadDrag = (event: ReactPointerEvent<HTMLButtonElement>, threadId: string, groupKey: string) => {
    if (threadSort !== 'manual' || event.button !== 0) return
    threadDrag.current = { id: threadId, groupKey, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, preview: null }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const previewThreadDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = threadDrag.current
    if (!drag) return
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return
    if (!drag.moved) {
      drag.moved = true
      setDraggedThreadId(drag.id)
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-thread-sort-id]')
    const targetId = target?.dataset.threadSortId
    const targetGroup = target?.closest<HTMLElement>('[data-workspace-group]')?.dataset.workspaceGroup
    if (!target || !targetId || targetGroup !== drag.groupKey || targetId === drag.id) return
    const bounds = target.getBoundingClientRect()
    const edge = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    if (threadDrop?.id === targetId && threadDrop.edge === edge) return
    const base = drag.preview ?? orderedThreads.map((thread) => thread.id)
    const next = reorderThreadIds(base, drag.id, targetId, edge)
    drag.preview = next
    setDragPreviewOrder(next)
    setThreadDrop({ id: targetId, edge })
  }

  const finishThreadDrag = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
    const drag = threadDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.moved) {
      suppressThreadClick.current = true
      window.setTimeout(() => { suppressThreadClick.current = false }, 0)
      if (commit && drag.preview) {
        const visibleIds = new Set(drag.preview)
        onManualThreadOrder([...drag.preview, ...manualThreadOrder.filter((id) => !visibleIds.has(id))])
      }
    }
    threadDrag.current = null
    setDragPreviewOrder(null)
    setDraggedThreadId(null)
    setThreadDrop(null)
  }

  const renderThreadList = (items: Thread[], groupKey: string) => (
    <ThreadList
      threads={items}
      states={threadStates}
      selectedThreadId={selectedThreadId}
      onSelect={onSelectThread}
      groupKey={groupKey}
      visibleCount={visibleCounts[groupKey]}
      manualSort={threadSort === 'manual'}
      draggedThreadId={draggedThreadId}
      threadDrop={threadDrop}
      onPointerStart={startThreadDrag}
      onPointerMove={previewThreadDrag}
      onPointerFinish={finishThreadDrag}
      suppressClick={() => suppressThreadClick.current}
      onShowMore={() => setVisibleCounts((current) => ({
        ...current,
        [groupKey]: visibleThreads(items, current[groupKey]).length + 5,
      }))}
    />
  )

  if (sidebarCollapsed) {
    return <aside className="sidebar sidebar-collapsed" aria-label="已收起的工作区与会话" />
  }

  return (
    <aside
      className={`sidebar ${resizing ? 'resizing' : ''}`}
      aria-label="工作区与会话"
      style={{ '--sidebar-width': `${displayedSidebarWidth}px` } as CSSProperties}
    >
      <div className="brand-row">
        <img className="brand-mark" src={isDevelopmentFlavor ? harnessDevIcon : harnessIcon} alt="" />
        <span className="brand-name">codex <strong>HARNESS</strong></span>
        <span className="brand-version">{isDevelopmentFlavor ? `DEV · v${harnessVersion}` : `v${harnessVersion}`}</span>
      </div>

      <button className="new-chat-button" type="button" onClick={onNewThread} disabled={creatingThread}>
        {creatingThread ? <LoaderCircle size={16} className="spin" /> : <CirclePlus size={17} />}
        新会话
      </button>

      <div className="sidebar-scroll">
        <div className={`sidebar-section-heading ${searchOpen ? 'searching' : ''}`}>
          {searchOpen ? (
            <div className="sidebar-search">
              <Search size={15} aria-hidden />
              <input
                ref={searchInputRef}
                aria-label="搜索会话"
                placeholder="搜索会话"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closeSearch()
                }}
              />
              <button type="button" onClick={closeSearch} aria-label="关闭搜索">×</button>
            </div>
          ) : (
            <button className="sidebar-search-trigger" type="button" onClick={() => setSearchOpen(true)} aria-label={`搜索${sectionLabel}中的会话`}>
              <Search size={15} aria-hidden />
              <span>{sectionLabel}</span>
            </button>
          )}
          <div className="heading-actions">
            {navigationLayout === 'workspace' && orderedWorkspaces.length > 0 && (
              <button
                type="button"
                title={allWorkspacesExpanded ? '折叠全部工作区' : '展开全部工作区'}
                aria-label={allWorkspacesExpanded ? '折叠全部工作区' : '展开全部工作区'}
                onClick={toggleAllWorkspaces}
              >
                {allWorkspacesExpanded ? <ChevronsUp size={15} /> : <ChevronsDown size={15} />}
              </button>
            )}
            <button type="button" title="视图与排序" onClick={() => setOptionsOpen((open) => !open)} aria-expanded={optionsOpen}>
              <SlidersHorizontal size={15} />
            </button>
            <button type="button" title="刷新会话" onClick={onRefresh}><RefreshCw size={15} /></button>
            {optionsOpen && (
              <div className="navigation-options" role="dialog" aria-label="会话视图与排序">
                <p>视图</p>
                <button type="button" className={navigationLayout === 'workspace' ? 'selected' : ''} onClick={() => { onNavigationLayout('workspace'); setOptionsOpen(false) }}>
                  <ListTree size={15} />按工作区
                </button>
                <button type="button" className={navigationLayout === 'list' ? 'selected' : ''} onClick={() => { onNavigationLayout('list'); setOptionsOpen(false) }}>
                  <LayoutList size={15} />单列表
                </button>
                {navigationLayout === 'workspace' && (
                  <>
                    <p>工作区</p>
                    <button type="button" className={workspaceSort === 'stable' ? 'selected' : ''} onClick={() => { onWorkspaceSort('stable'); setOptionsOpen(false) }}>
                      <ListTree size={15} />固定顺序
                    </button>
                    <button type="button" className={workspaceSort === 'recent' ? 'selected' : ''} onClick={() => { onWorkspaceSort('recent'); setOptionsOpen(false) }}>
                      <Clock3 size={15} />最近会话
                    </button>
                    {workspaceSort === 'recent' && <small>按每个工作区最新会话的时间排列。</small>}
                  </>
                )}
                <p>会话排序</p>
                <button type="button" className={threadSort === 'recent' ? 'selected' : ''} onClick={() => { onThreadSort('recent'); setOptionsOpen(false) }}>
                  最近更新
                </button>
                <button type="button" className={threadSort === 'manual' ? 'selected' : ''} onClick={() => { onThreadSort('manual'); setOptionsOpen(false) }}>
                  手动排序
                </button>
                {threadSort === 'manual' && <small>拖拽会话即可调整顺序</small>}
              </div>
            )}
          </div>
        </div>

        {workspaces.length === 0 && viewMode === 'active' && (
          <div className="workspace-empty static">
            <FolderGit2 size={18} />
            <span>暂无 Git 主工作区</span>
            <small>请从新会话中选择目录</small>
          </div>
        )}

        {navigationLayout === 'list' ? (
          <section className="workspace-group single-list-group">
            <div className="workspace-row static">
              <LayoutList size={16} />
              <span>全部会话</span>
              <em>{orderedThreads.length || ''}</em>
            </div>
            {renderThreadList(orderedThreads, 'all')}
          </section>
        ) : (
          <>
            {orderedWorkspaces.map((workspace) => {
              const isExpanded = expanded[workspace.root] ?? true
              const workspaceThreads = grouped.byRoot.get(workspace.root) ?? []
              return (
                <section className="workspace-group" key={workspace.root}>
                  <button
                    type="button"
                    className={`workspace-row ${highlightedWorkspaceRoot === workspace.root ? 'selected' : ''}`}
                    onClick={() => {
                      setHighlightedWorkspaceRoot(workspace.root)
                      onSelectWorkspace(workspace.root)
                      setExpanded((current) => ({ ...current, [workspace.root]: !(current[workspace.root] ?? true) }))
                    }}
                    title={workspace.root}
                  >
                    {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    <FolderGit2 size={16} />
                    <span>{workspace.name}</span>
                    <em>{workspaceThreads.length || ''}</em>
                  </button>
                  {isExpanded && renderThreadList(workspaceThreads, workspace.root)}
                </section>
              )
            })}

            {grouped.unsorted.length > 0 && (
              <section className="workspace-group unsorted-group">
                <div className="workspace-row static">
                  <FolderGit2 size={16} />
                  <span>未分组</span>
                  <em>{grouped.unsorted.length}</em>
                </div>
                {renderThreadList(grouped.unsorted, 'unsorted')}
              </section>
            )}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="archive-split">
          <button
            type="button"
            className={`archive-toggle ${viewMode === 'archived' ? 'active solo' : ''}`}
            title={viewMode === 'active' ? '归档不会删除会话，可随时在这里恢复。' : '返回未归档会话'}
            onClick={() => onViewMode(viewMode === 'active' ? 'archived' : 'active')}
          >
            {viewMode === 'active' ? <Archive size={16} /> : <ArchiveRestore size={16} />}
            {viewMode === 'active' ? '已归档会话' : '返回会话'}
          </button>
          {viewMode === 'active' && (
            <button
              type="button"
              className="archive-old-button"
              title="归档 3 天前会话"
              aria-label="归档 3 天前会话"
              onClick={onArchiveOldThreads}
              disabled={archivingOldThreads}
            >
              {archivingOldThreads ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />}
            </button>
          )}
        </div>
        <div className="settings-split">
          <button type="button" className="settings-toggle" onClick={onOpenSettings}>
            <Settings2 size={16} />
            设置
          </button>
          <button type="button" className="plugins-toggle" onClick={onOpenPlugins} title="插件" aria-label="打开插件">
            <Blocks size={16} />
          </button>
        </div>
      </div>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={displayedSidebarWidth}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeWithKeyboard}
      />
    </aside>
  )
}

function ThreadList({
  threads,
  states,
  selectedThreadId,
  onSelect,
  groupKey,
  visibleCount,
  manualSort,
  draggedThreadId,
  threadDrop,
  onPointerStart,
  onPointerMove,
  onPointerFinish,
  suppressClick,
  onShowMore,
}: {
  threads: Thread[]
  states: Record<string, ThreadUiState>
  selectedThreadId: string | null
  onSelect: (threadId: string) => void
  groupKey: string
  visibleCount: number | undefined
  manualSort: boolean
  draggedThreadId: string | null
  threadDrop: { id: string; edge: 'before' | 'after' } | null
  onPointerStart: (event: ReactPointerEvent<HTMLButtonElement>, threadId: string, groupKey: string) => void
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerFinish: (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => void
  suppressClick: () => boolean
  onShowMore: () => void
}) {
  if (threads.length === 0) return <p className="empty-thread-list">暂无会话</p>
  const shownThreads = visibleThreads(threads, visibleCount)
  return (
    <div className="thread-list" data-workspace-group={groupKey}>
      {shownThreads.map((thread) => {
        const badge = resolveThreadBadge(thread, states[thread.id]?.badge ?? null)
        return (
          <button
            key={thread.id}
            type="button"
            data-thread-sort-id={thread.id}
            className={`thread-row ${selectedThreadId === thread.id ? 'selected' : ''} ${manualSort ? 'manual-sort' : ''}${draggedThreadId === thread.id ? ' dragging' : ''}${threadDrop?.id === thread.id && draggedThreadId !== thread.id ? ` drop-${threadDrop.edge}` : ''}`}
            onClick={(event) => {
              if (suppressClick()) event.preventDefault()
              else onSelect(thread.id)
            }}
            onPointerDown={(event) => onPointerStart(event, thread.id, groupKey)}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => onPointerFinish(event, true)}
            onPointerCancel={(event) => onPointerFinish(event, false)}
            title={thread.name || thread.preview || '新会话'}
          >
            <StatusDot badge={badge} />
            <span className="thread-row-title">{truncate(thread.name || thread.preview || '新会话', 42)}</span>
            <time>{isActive(thread.status) ? '运行中' : relativeTime(thread.recencyAt ?? thread.updatedAt)}</time>
          </button>
        )
      })}
      {shownThreads.length < threads.length && (
        <button className="show-more-sessions" type="button" onClick={onShowMore}>
          显示更多（+{Math.min(5, threads.length - shownThreads.length)}）
        </button>
      )}
    </div>
  )
}

export function reorderThreadIds(ids: string[], draggedId: string, targetId: string, edge: 'before' | 'after'): string[] {
  const next = [...ids]
  const from = next.indexOf(draggedId)
  if (from < 0 || !next.includes(targetId) || draggedId === targetId) return ids
  next.splice(from, 1)
  const target = next.indexOf(targetId)
  next.splice(target + (edge === 'after' ? 1 : 0), 0, draggedId)
  return next
}

export function StatusDot({ badge }: { badge: Badge }) {
  if (!badge) return <span className="status-dot empty" aria-hidden />
  if (badge === 'working') return <svg className="status-dot working" viewBox="0 0 12 12" aria-label="运行中"><circle cx="6" cy="6" r="4.5" /></svg>
  return <span className={`status-dot ${badge}`} aria-label={badge === 'approval' ? '等待审批' : badge === 'error' ? '发生错误' : '有新回复'} />
}
