import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  FolderGit2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react'
import type { Badge, Thread, ThreadUiState, Workspace } from '../../core/domain/codex'
import { relativeTime, truncate } from '../../core/domain/format'

interface SidebarProps {
  workspaces: Workspace[]
  threads: Thread[]
  threadRoots: Record<string, string | null>
  threadStates: Record<string, ThreadUiState>
  selectedThreadId: string | null
  selectedWorkspaceRoot: string | null
  viewMode: 'active' | 'archived'
  creatingThread: boolean
  onSelectThread: (threadId: string) => void
  onSelectWorkspace: (root: string) => void
  onNewThread: () => void
  onChooseWorkspace: () => void
  onSearch: (term: string) => void
  onRefresh: () => void
  onViewMode: (mode: 'active' | 'archived') => void
}

export function Sidebar({
  workspaces,
  threads,
  threadRoots,
  threadStates,
  selectedThreadId,
  selectedWorkspaceRoot,
  viewMode,
  creatingThread,
  onSelectThread,
  onSelectWorkspace,
  onNewThread,
  onChooseWorkspace,
  onSearch,
  onRefresh,
  onViewMode,
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
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

  const grouped = useMemo(() => {
    const byRoot = new Map<string, Thread[]>()
    const unsorted: Thread[] = []
    const roots = new Set(workspaces.map((workspace) => workspace.root))
    for (const thread of threads) {
      const root = threadRoots[thread.id]
      if (root && roots.has(root)) byRoot.set(root, [...(byRoot.get(root) ?? []), thread])
      else unsorted.push(thread)
    }
    return { byRoot, unsorted }
  }, [threadRoots, threads, workspaces])

  return (
    <aside className="sidebar" aria-label="工作区与会话">
      <div className="brand-row">
        <div className="brand-mark">C</div>
        <span className="brand-name">codex <strong>HARNESS</strong></span>
        <span className="brand-version">v1</span>
      </div>

      <button className="new-chat-button" type="button" onClick={onNewThread} disabled={creatingThread}>
        {creatingThread ? <LoaderCircle size={15} className="spin" /> : <CirclePlus size={16} />}
        新会话
      </button>

      <div className="sidebar-search">
        <Search size={15} />
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
          <span>工作区</span>
          <div className="heading-actions">
            <button type="button" title="刷新会话" onClick={onRefresh}><RefreshCw size={14} /></button>
            <button type="button" title="添加 Git 工作区" onClick={onChooseWorkspace}><Plus size={16} /></button>
          </div>
        </div>

        {workspaces.length === 0 && viewMode === 'active' && (
          <button className="workspace-empty" type="button" onClick={onChooseWorkspace}>
            <FolderGit2 size={17} />
            <span>添加 Git 主工作区</span>
            <small>Worktree 不会显示在此处</small>
          </button>
        )}

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
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <FolderGit2 size={15} />
                <span>{workspace.name}</span>
                <em>{workspaceThreads.length || ''}</em>
              </button>
              {isExpanded && (
                <ThreadList
                  threads={workspaceThreads}
                  states={threadStates}
                  selectedThreadId={selectedThreadId}
                  onSelect={onSelectThread}
                  groupKey={workspace.root}
                  visibleCount={visibleCounts[workspace.root]}
                  onShowMore={() => setVisibleCounts((current) => ({
                    ...current,
                    [workspace.root]: (current[workspace.root] ?? initialVisibleCount(workspaceThreads)) + 5,
                  }))}
                />
              )}
            </section>
          )
        })}

        {grouped.unsorted.length > 0 && (
          <section className="workspace-group unsorted-group">
            <div className="workspace-row static">
              <FolderGit2 size={15} />
              <span>未分组</span>
              <em>{grouped.unsorted.length}</em>
            </div>
            <ThreadList
              threads={grouped.unsorted}
              states={threadStates}
              selectedThreadId={selectedThreadId}
              onSelect={onSelectThread}
              groupKey="unsorted"
              visibleCount={visibleCounts.unsorted}
              onShowMore={() => setVisibleCounts((current) => ({
                ...current,
                unsorted: (current.unsorted ?? initialVisibleCount(grouped.unsorted)) + 5,
              }))}
            />
          </section>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className={`archive-toggle ${viewMode === 'archived' ? 'active' : ''}`}
          onClick={() => onViewMode(viewMode === 'active' ? 'archived' : 'active')}
        >
          {viewMode === 'active' ? <Archive size={15} /> : <ArchiveRestore size={15} />}
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
  onShowMore,
}: {
  threads: Thread[]
  states: Record<string, ThreadUiState>
  selectedThreadId: string | null
  onSelect: (threadId: string) => void
  groupKey: string
  visibleCount: number | undefined
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
            className={`thread-row ${selectedThreadId === thread.id ? 'selected' : ''}`}
            onClick={() => onSelect(thread.id)}
            title={thread.name || thread.preview || '新会话'}
          >
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
