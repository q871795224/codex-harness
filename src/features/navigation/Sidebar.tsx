import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  FolderGit2,
  GripVertical,
  LayoutList,
  ListTree,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import type {
  Badge,
  NavigationLayout,
  Thread,
  ThreadSort,
  ThreadUiState,
  Workspace,
} from '../../core/domain/codex'
import { relativeTime, truncate } from '../../core/domain/format'

interface SidebarProps {
  workspaces: Workspace[]
  threads: Thread[]
  threadRoots: Record<string, string | null>
  threadStates: Record<string, ThreadUiState>
  selectedThreadId: string | null
  selectedWorkspaceRoot: string | null
  viewMode: 'active' | 'archived'
  navigationLayout: NavigationLayout
  threadSort: ThreadSort
  manualThreadOrder: string[]
  creatingThread: boolean
  onSelectThread: (threadId: string) => void
  onSelectWorkspace: (root: string) => void
  onNewThread: () => void
  onChooseWorkspace: () => void
  onSearch: (term: string) => void
  onRefresh: () => void
  onViewMode: (mode: 'active' | 'archived') => void
  onNavigationLayout: (layout: NavigationLayout) => void
  onThreadSort: (sort: ThreadSort) => void
  onManualThreadOrder: (order: string[]) => void
}

export function Sidebar({
  workspaces,
  threads,
  threadRoots,
  threadStates,
  selectedThreadId,
  selectedWorkspaceRoot,
  viewMode,
  navigationLayout,
  threadSort,
  manualThreadOrder,
  creatingThread,
  onSelectThread,
  onSelectWorkspace,
  onNewThread,
  onChooseWorkspace,
  onSearch,
  onRefresh,
  onViewMode,
  onNavigationLayout,
  onThreadSort,
  onManualThreadOrder,
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const [optionsOpen, setOptionsOpen] = useState(false)
  const onSearchRef = useRef(onSearch)
  const searchStarted = useRef(false)

  useEffect(() => {
    onSearchRef.current = onSearch
  }, [onSearch])

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

  const orderedThreads = useMemo(
    () => sortThreads(threads, threadSort, manualThreadOrder),
    [manualThreadOrder, threadSort, threads],
  )

  const grouped = useMemo(() => {
    const byRoot = new Map<string, Thread[]>()
    const unsorted: Thread[] = []
    const roots = new Set(workspaces.map((workspace) => workspace.root))
    for (const thread of orderedThreads) {
      const root = threadRoots[thread.id]
      if (root && roots.has(root)) byRoot.set(root, [...(byRoot.get(root) ?? []), thread])
      else unsorted.push(thread)
    }
    return { byRoot, unsorted }
  }, [orderedThreads, threadRoots, workspaces])

  const reorderThread = (draggedThreadId: string, targetThreadId: string) => {
    if (threadSort !== 'manual' || draggedThreadId === targetThreadId) return
    const orderedIds = orderedThreads.map((thread) => thread.id)
    const from = orderedIds.indexOf(draggedThreadId)
    const to = orderedIds.indexOf(targetThreadId)
    if (from < 0 || to < 0) return
    orderedIds.splice(from, 1)
    orderedIds.splice(to, 0, draggedThreadId)
    const visibleIds = new Set(orderedIds)
    // A search can show a subset. Keep the saved relative order of threads that are not
    // currently present in the App Server page instead of silently losing them.
    onManualThreadOrder([...orderedIds, ...manualThreadOrder.filter((id) => !visibleIds.has(id))])
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
      onReorder={reorderThread}
      onShowMore={() => setVisibleCounts((current) => ({
        ...current,
        [groupKey]: (current[groupKey] ?? initialVisibleCount(items)) + 5,
      }))}
    />
  )

  return (
    <aside className="sidebar" aria-label="工作区与会话">
      <div className="brand-row">
        <div className="brand-mark">C</div>
        <span className="brand-name">codex <strong>HARNESS</strong></span>
        <span className="brand-version">v1</span>
      </div>

      <button className="new-chat-button" type="button" onClick={onNewThread} disabled={creatingThread}>
        {creatingThread ? <LoaderCircle size={16} className="spin" /> : <CirclePlus size={17} />}
        新会话
      </button>

      <div className="sidebar-search">
        <Search size={16} />
        <input
          aria-label="搜索会话"
          placeholder="搜索会话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="清除搜索">×</button>}
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-section-heading">
          <span>{navigationLayout === 'workspace' ? '工作区' : '会话'}</span>
          <div className="heading-actions">
            <button type="button" title="视图与排序" onClick={() => setOptionsOpen((open) => !open)} aria-expanded={optionsOpen}>
              <SlidersHorizontal size={15} />
            </button>
            <button type="button" title="刷新会话" onClick={onRefresh}><RefreshCw size={15} /></button>
            <button type="button" title="添加 Git 工作区" onClick={onChooseWorkspace}><Plus size={17} /></button>
            {optionsOpen && (
              <div className="navigation-options" role="dialog" aria-label="会话视图与排序">
                <p>视图</p>
                <button type="button" className={navigationLayout === 'workspace' ? 'selected' : ''} onClick={() => { onNavigationLayout('workspace'); setOptionsOpen(false) }}>
                  <ListTree size={15} />按工作区
                </button>
                <button type="button" className={navigationLayout === 'list' ? 'selected' : ''} onClick={() => { onNavigationLayout('list'); setOptionsOpen(false) }}>
                  <LayoutList size={15} />单列表
                </button>
                <p>排序</p>
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
          <button className="workspace-empty" type="button" onClick={onChooseWorkspace}>
            <FolderGit2 size={18} />
            <span>添加 Git 主工作区</span>
            <small>Worktree 不会显示在此处</small>
          </button>
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
            {workspaces.map((workspace) => {
              const isExpanded = expanded[workspace.root] ?? true
              const workspaceThreads = grouped.byRoot.get(workspace.root) ?? []
              return (
                <section className="workspace-group" key={workspace.root}>
                  <button
                    type="button"
                    className={`workspace-row ${selectedWorkspaceRoot === workspace.root ? 'selected' : ''}`}
                    onClick={() => {
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
        <button
          type="button"
          className={`archive-toggle ${viewMode === 'archived' ? 'active' : ''}`}
          title={viewMode === 'active' ? '归档不会删除会话，可随时在这里恢复。' : '返回未归档会话'}
          onClick={() => onViewMode(viewMode === 'active' ? 'archived' : 'active')}
        >
          {viewMode === 'active' ? <Archive size={16} /> : <ArchiveRestore size={16} />}
          {viewMode === 'active' ? '已归档会话' : '返回会话'}
        </button>
      </div>
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
  onReorder,
  onShowMore,
}: {
  threads: Thread[]
  states: Record<string, ThreadUiState>
  selectedThreadId: string | null
  onSelect: (threadId: string) => void
  groupKey: string
  visibleCount: number | undefined
  manualSort: boolean
  onReorder: (draggedThreadId: string, targetThreadId: string) => void
  onShowMore: () => void
}) {
  if (threads.length === 0) return <p className="empty-thread-list">暂无会话</p>
  const defaultCount = initialVisibleCount(threads)
  const shown = Math.min(threads.length, Math.max(defaultCount, visibleCount ?? defaultCount))
  const visibleThreads = threads.slice(0, shown)
  return (
    <div className="thread-list" data-workspace-group={groupKey}>
      {visibleThreads.map((thread) => {
        const badge = states[thread.id]?.badge ?? activityBadge(thread)
        return (
          <button
            key={thread.id}
            type="button"
            draggable={manualSort}
            className={`thread-row ${selectedThreadId === thread.id ? 'selected' : ''} ${manualSort ? 'manual-sort' : ''}`}
            onClick={() => onSelect(thread.id)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', thread.id)
            }}
            onDragOver={(event) => {
              if (manualSort) event.preventDefault()
            }}
            onDrop={(event) => {
              event.preventDefault()
              onReorder(event.dataTransfer.getData('text/plain'), thread.id)
            }}
            title={thread.name || thread.preview || '新会话'}
          >
            {manualSort && <GripVertical className="thread-drag-handle" size={14} aria-hidden />}
            <StatusDot badge={badge} />
            <span className="thread-row-title">{truncate(thread.name || thread.preview || '新会话', 42)}</span>
            <time>{relativeTime(thread.recencyAt ?? thread.updatedAt)}</time>
          </button>
        )
      })}
      {shown < threads.length && (
        <button className="show-more-sessions" type="button" onClick={onShowMore}>
          显示更多（+{Math.min(5, threads.length - shown)}）
        </button>
      )}
    </div>
  )
}

function sortThreads(threads: Thread[], sort: ThreadSort, manualOrder: string[]): Thread[] {
  const recentFirst = [...threads].sort((left, right) => {
    const leftDate = left.recencyAt ?? left.updatedAt
    const rightDate = right.recencyAt ?? right.updatedAt
    return rightDate - leftDate
  })
  if (sort === 'recent') return recentFirst

  const ranks = new Map(manualOrder.map((id, index) => [id, index]))
  return recentFirst.sort((left, right) => {
    const leftRank = ranks.get(left.id)
    const rightRank = ranks.get(right.id)
    if (leftRank === undefined && rightRank === undefined) return 0
    if (leftRank === undefined) return 1
    if (rightRank === undefined) return -1
    return leftRank - rightRank
  })
}

function initialVisibleCount(threads: Thread[]): number {
  if (threads.length <= 5) return threads.length
  const cutoff = Date.now() / 1_000 - 3 * 24 * 60 * 60
  const recentCount = threads.filter((thread) => (thread.recencyAt ?? thread.updatedAt) >= cutoff).length
  return Math.max(3, Math.min(5, recentCount))
}

export function StatusDot({ badge }: { badge: Badge }) {
  if (!badge) return <span className="status-dot empty" aria-hidden />
  if (badge === 'working') return <span className="status-dot working" aria-label="运行中" />
  return <span className={`status-dot ${badge}`} aria-label={badge === 'approval' ? '等待审批' : badge === 'error' ? '发生错误' : '有新回复'} />
}

function activityBadge(thread: Thread): Badge {
  if (thread.status.type === 'systemError') return 'error'
  if (thread.status.type === 'active' && thread.status.activeFlags.includes('waitingOnApproval')) return 'approval'
  if (thread.status.type === 'active') return 'working'
  return null
}
