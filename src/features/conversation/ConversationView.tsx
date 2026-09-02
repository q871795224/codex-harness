import { memo, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  Bot,
  Check,
  CircleAlert,
  CircleStop,
  ChevronDown,
  ChevronRight,
  Command,
  Copy,
  FileCode2,
  FileText,
  GitBranch,
  GitFork,
  Image,
  Pencil,
  Pin,
  PinOff,
  ShieldAlert,
  Sparkles,
  Terminal,
  UserRound,
  Wrench,
} from 'lucide-react'
import type { ApprovalRequest, Thread, ThreadItemEntry, Turn, Workspace } from '../../core/domain/codex'
import { itemText, threadTitle } from '../../core/domain/codex'
import { formatDuration, truncate } from '../../core/domain/format'
import { displayCommand } from './commandDisplay'
import { groupTranscriptTurns, summarizeProcessRows, type TranscriptItem, type TranscriptTurn } from './transcript'
import { runtime } from '../../core/runtime/bridge'
import { WorkingStatus } from './ConversationStats'
import { collectNativeAgentActivities, type NativeAgentActivity } from './agentActivity'

interface ConversationHeaderProps {
  thread: Thread
  workspace: Workspace | null
  gitContextResolved: boolean
  archived: boolean
  pinned: boolean
  workspaceChanging: boolean
  canChangeWorkspace: boolean
  onRename: (name: string) => void
  onArchive: () => void
  onUnarchive: () => void
  onTogglePinned: () => void
  onChooseWorkspace: () => void
  onOpenThread?: (threadId: string) => void
  headerActions?: ReactNode
}

export function ConversationHeader({ thread, workspace, gitContextResolved, archived, pinned, workspaceChanging, canChangeWorkspace, onRename, onArchive, onUnarchive, onTogglePinned, onChooseWorkspace, onOpenThread, headerActions }: ConversationHeaderProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(threadTitle(thread))

  const saveTitle = () => {
    onRename(title)
    setEditingTitle(false)
  }

  return (
    <header className="thread-header">
      <div className="thread-title-wrap">
        {editingTitle ? (
          <input
            autoFocus
            className="thread-title-editor"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              const action = titleEditorKeyAction(event.key, event.nativeEvent.isComposing, event.keyCode)
              if (action === 'cancel') {
                setTitle(threadTitle(thread))
                setEditingTitle(false)
              }
              if (action === 'save') saveTitle()
            }}
          />
        ) : (
          <button
            className="thread-title-button"
            type="button"
            onClick={() => {
              setTitle(threadTitle(thread))
              setEditingTitle(true)
            }}
            title="重命名会话"
          >
            <h1>{threadTitle(thread)}</h1>
            <Pencil size={15} />
          </button>
        )}
        <div className="thread-context">
          <span><GitBranch size={13} />{workspace?.name ?? '未分组'}</span>
          <span>{threadGitContextLabel(thread.gitInfo, gitContextResolved)}</span>
          {thread.forkedFromId && (
            <button type="button" className="thread-origin" onClick={() => onOpenThread?.(thread.forkedFromId!)} title="打开分支来源会话">
              <GitFork size={12} />来自 {thread.forkedFromId.slice(0, 8)}
            </button>
          )}
          <button
            type="button"
            className="thread-path"
            title={`${thread.cwd}\n点击切换 checkout 或 worktree`}
            disabled={!canChangeWorkspace || workspaceChanging}
            onClick={onChooseWorkspace}
          >
            {workspaceChanging ? '正在切换…' : thread.cwd}
          </button>
          {headerActions && <span className="thread-header-actions">{headerActions}</span>}
        </div>
      </div>
      <div className="thread-header-primary-actions">
        <button
          type="button"
          className={`header-action ${pinned ? 'pinned' : ''}`}
          onClick={onTogglePinned}
          title={pinned ? '取消置顶会话' : '置顶会话'}
          aria-pressed={pinned}
        >
          {pinned ? <PinOff size={16} /> : <Pin size={16} />}
          {pinned ? '取消置顶' : '置顶'}
        </button>
        <button
          type="button"
          className="header-action"
          onClick={archived ? onUnarchive : onArchive}
          title={archived ? '恢复会话' : '归档会话'}
        >
          {archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
          {archived ? '恢复' : '归档'}
        </button>
      </div>
    </header>
  )
}

export function threadGitContextLabel(thread: Thread['gitInfo'], resolved: boolean): string {
  if (!resolved) return '-'
  if (thread?.branch) return thread.branch
  return thread?.sha?.slice(0, 7) ?? '-'
}

export function titleEditorKeyAction(key: string, isComposing: boolean, keyCode = 0): 'save' | 'cancel' | null {
  if (isComposing || keyCode === 229) return null
  if (key === 'Escape') return 'cancel'
  if (key === 'Enter') return 'save'
  return null
}

interface ConversationViewProps {
  provider?: 'codex' | 'claude'
  items: ThreadItemEntry[]
  turns: Turn[]
  cwd: string
  approvals: ApprovalRequest[]
  workspace: Workspace | null
  workspaces: Workspace[]
  workspaceChanging: boolean
  initialScrollTop: number | null
  scrollToLatestRequest: number
  hasOlderTurns: boolean
  loadingOlderTurns: boolean
  onAnswerApproval: (request: ApprovalRequest, decision: unknown) => void
  onLoadOlderTurns: () => void
  onScrollPosition: (scrollTop: number) => void
  onWorkspaceChange: (workspaceRoot: string) => void
  onChooseWorkspace: () => void
  onForkTurn?: (turnId: string) => void
  forkingTurnId?: string | null
  onOpenThread?: (threadId: string) => void
  rawOverrides?: ReadonlySet<string>
  onRawOverrideToggle?: (messageKey: string) => void
  agentApprovalCounts?: Record<string, number>
  activeTurnIds?: Record<string, string>
  onInterruptAgent?: (threadId: string) => void
  newThreadPanels?: ReactNode
  recap?: { text: string; createdAt: number } | null
  rawMode: boolean
  working: boolean
  workingTurnId: string | null
  workingStartedAt: number | null
  onRawModeToggle: () => void
  onContinueAfterFailure?: () => void
  continueDisabled?: boolean
}

export function ConversationView({ provider = 'codex', items, turns, cwd, approvals, workspace, workspaces, workspaceChanging, initialScrollTop, scrollToLatestRequest, hasOlderTurns, loadingOlderTurns, onAnswerApproval, onLoadOlderTurns, onScrollPosition, onWorkspaceChange, onChooseWorkspace, onForkTurn, forkingTurnId = null, onOpenThread, rawOverrides, onRawOverrideToggle, agentApprovalCounts = {}, activeTurnIds = {}, onInterruptAgent, newThreadPanels, recap, rawMode, working, workingTurnId, workingStartedAt, onRawModeToggle, onContinueAfterFailure, continueDisabled = false }: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const initiallyPositioned = useRef(false)
  const followingLatest = useRef(initialScrollTop === null)
  const handledScrollRequest = useRef(scrollToLatestRequest)
  const observedContentHeight = useRef(0)

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || initiallyPositioned.current) return
    scroll.scrollTop = initialScrollTop ?? scroll.scrollHeight
    followingLatest.current = initialScrollTop === null || isNearConversationBottom(scroll)
    initiallyPositioned.current = true
  }, [initialScrollTop, items.length])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || handledScrollRequest.current === scrollToLatestRequest) return
    handledScrollRequest.current = scrollToLatestRequest
    followingLatest.current = true
    scroll.scrollTop = scroll.scrollHeight
  }, [scrollToLatestRequest])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || !initiallyPositioned.current) return
    if (followingLatest.current && observedContentHeight.current !== scroll.scrollHeight) {
      scroll.scrollTop = scroll.scrollHeight
    }
    observedContentHeight.current = scroll.scrollHeight
  })

  const scrollToBottom = () => {
    followingLatest.current = true
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }
  const rawTranscriptRows = items.map((entry) => ({ entry, agentText: undefined, showAgentLabel: true }))
  const agentLabel = provider === 'claude' ? 'Claude' : 'Codex'
  const turnDetails = turns.map((turn) => ({ id: turn.id, status: turn.status, error: turn.error }))
  const activeTurnIndex = turnDetails.findIndex((turn) => turn.id === workingTurnId)
  if (workingTurnId && activeTurnIndex >= 0) turnDetails[activeTurnIndex] = { ...turnDetails[activeTurnIndex], status: 'inProgress' }
  else if (workingTurnId) turnDetails.push({ id: workingTurnId, status: 'inProgress', error: null })
  const transcriptTurns = rawMode ? [] : groupTranscriptTurns(items, turnDetails)
  const latestTurnId = turns.at(-1)?.id ?? null
  const workingMessageIndex = rawMode && working ? latestAgentMessageIndex(rawTranscriptRows, workingTurnId) : -1
  const activeTurnHasContent = transcriptTurns.some((turn) => turn.turnId === workingTurnId && (turn.processRows.length > 0 || turn.finalRows.length > 0))
  const agentActivities = collectNativeAgentActivities(items, agentApprovalCounts)

  return (
    <section className="conversation-pane" aria-label="对话内容">
      {working && <div className="conversation-working-line" aria-hidden><span /></div>}
      <div className="conversation-scroll" ref={scrollRef} onScroll={(event) => {
        followingLatest.current = isNearConversationBottom(event.currentTarget)
        onScrollPosition(event.currentTarget.scrollTop)
      }}>
        <div className="message-column">
          {rawMode && (
            <div className="raw-mode-banner" role="status">
              <Terminal size={13} />
              <span><strong>RAW</strong> 原始 Markdown 文本</span>
              <button type="button" onClick={onRawModeToggle}>退出</button>
            </div>
          )}
          {hasOlderTurns && (
            <button className="load-older-turns" type="button" onClick={onLoadOlderTurns} disabled={loadingOlderTurns}>
              {loadingOlderTurns ? '正在加载更早消息…' : '加载更早消息'}
            </button>
          )}
          {agentActivities.length > 0 && (
            <AgentActivitySummary
              activities={agentActivities}
              activeTurnIds={activeTurnIds}
              onOpenThread={onOpenThread}
              onInterrupt={onInterruptAgent}
            />
          )}
          {items.length === 0 && (
            <div className="fresh-thread-wrap">
              <div className="fresh-thread">
                <div className="fresh-thread-mark"><Bot size={18} /></div>
                <p>
                  在
                  <span className="fresh-workspace-select">
                    <select
                      value={workspace?.root ?? ''}
                      aria-label="切换新会话工作区"
                      disabled={workspaceChanging}
                      onChange={(event) => {
                        if (isChooseWorkspaceSelection(event.target.value)) onChooseWorkspace()
                        else onWorkspaceChange(event.target.value)
                      }}
                    >
                      {!workspace && <option value="">当前工作区</option>}
                      {workspaces.map((candidate) => <option key={candidate.root} value={candidate.root}>{candidate.name}</option>)}
                      <option value={CHOOSE_WORKSPACE_VALUE}>… 选择其他目录</option>
                    </select>
                    <ChevronDown size={14} aria-hidden />
                  </span>
                  开启一段新的 {provider === 'claude' ? 'Claude' : 'Codex'} 会话吧。
                </p>
              </div>
              {newThreadPanels}
            </div>
          )}
          {rawMode ? rawTranscriptRows.map((row, index) => (
            <ThreadItemView
              key={transcriptRowKey(row, index)}
              entry={row.entry}
              agentText={row.agentText}
              showAgentLabel={row.showAgentLabel}
              rawMode
              rawOverrides={rawOverrides}
              onRawOverrideToggle={onRawOverrideToggle}
              cwd={cwd}
              agentLabel={agentLabel}
              onOpenThread={onOpenThread}
              workingStartedAt={index === workingMessageIndex ? workingStartedAt : undefined}
            />
          )) : transcriptTurns.map((turn) => (
            <TranscriptTurnView
              key={turn.turnId}
              turn={turn}
              agentLabel={agentLabel}
              working={working && turn.turnId === workingTurnId}
              workingStartedAt={workingStartedAt}
              canContinue={Boolean(onContinueAfterFailure) && !working && !continueDisabled && latestTurnId === turn.turnId}
              onContinue={onContinueAfterFailure}
              cwd={cwd}
              onOpenThread={onOpenThread}
              onFork={onForkTurn}
              forking={forkingTurnId === turn.turnId}
              rawOverrides={rawOverrides}
              onRawOverrideToggle={onRawOverrideToggle}
            />
          ))}
          {rawMode && turns.filter((turn) => turn.status === 'failed').map((turn) => (
            <TurnFailureNotice
              key={`failure:${turn.id}`}
              error={turn.error}
              agentLabel={agentLabel}
              canContinue={Boolean(onContinueAfterFailure) && !working && !continueDisabled && latestTurnId === turn.id}
              onContinue={onContinueAfterFailure}
            />
          ))}
          {working && (rawMode ? workingMessageIndex < 0 : !activeTurnHasContent) && (
            <article className="message agent-message working-message">
              <div className="message-label"><Bot size={15} />{agentLabel}</div>
              <WorkingStatus startedAt={workingStartedAt} />
            </article>
          )}
          {recap && (
            <div className="recap-banner" role="status">
              <Sparkles size={14} aria-hidden />
              <div className="recap-banner-body">
                <strong>会话回顾</strong>
                <p>{recap.text}</p>
              </div>
            </div>
          )}
          {approvals.map((request) => (
            <ApprovalCard key={String(request.id)} request={request} onAnswer={onAnswerApproval} />
          ))}
        </div>
      </div>
      <button type="button" className="scroll-to-bottom" onClick={scrollToBottom} title="回到对话底部" aria-label="回到对话底部">
        <ArrowDownToLine size={17} />
      </button>
    </section>
  )
}

function AgentActivitySummary({ activities, activeTurnIds, onOpenThread, onInterrupt }: {
  activities: NativeAgentActivity[]
  activeTurnIds: Record<string, string>
  onOpenThread?: (threadId: string) => void
  onInterrupt?: (threadId: string) => void
}) {
  const activeCount = activities.filter((activity) => activeTurnIds[activity.threadId] || isAgentActive(activity.status)).length
  return (
    <section className="agent-activity-summary" aria-label="Agent Activity">
      <header><span><GitFork size={14} />Agent Activity</span><small>{activeCount > 0 ? `${activeCount} 个运行中` : `${activities.length} 个 Agent`}</small></header>
      <div>
        {activities.map((activity) => (
          <article key={activity.threadId}>
            <button type="button" className="agent-activity-open" onClick={() => onOpenThread?.(activity.threadId)} disabled={!onOpenThread} title="打开子 Agent 会话">
              <strong>{activity.task ? truncate(activity.task, 72) : collabToolLabel(activity.tool)}</strong>
              <span>{activityStatusLabel(activity.status)}</span>
              {activity.approvalCount > 0 && <em>{activity.approvalCount} 个审批</em>}
              {activity.message && <small>{truncate(activity.message, 90)}</small>}
            </button>
            {activeTurnIds[activity.threadId] && onInterrupt && (
              <button type="button" className="agent-activity-stop" onClick={() => onInterrupt(activity.threadId)} title="停止子 Agent 当前轮">
                <CircleStop size={13} />停止
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

function isAgentActive(status: string): boolean {
  return status === 'pendingInit' || status === 'running' || status === 'inProgress'
}

function transcriptRowKey(row: TranscriptItem, index: number): string {
  return `${row.entry.turnId}:${row.entry.item.id ?? index}`
}

// Stable per-message key used for the per-message raw override. Only text
// messages (user / agent) get a raw toggle; for those the item id is reliable.
export function messageRawKey(entry: ThreadItemEntry): string | null {
  const id = entry.item.id
  if (!id) return null
  return `${entry.turnId}:${id}`
}

export function isNearConversationBottom(scroll: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>): boolean {
  return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 48
}

export function latestAgentMessageIndex(rows: Array<{ entry: ThreadItemEntry }>, turnId: string | null): number {
  if (!turnId) return -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.entry.turnId === turnId && row.entry.item.type === 'agentMessage') return index
  }
  return -1
}

function TranscriptTurnView({ turn, agentLabel, working, workingStartedAt, canContinue, onContinue, cwd, onOpenThread, onFork, forking, rawOverrides, onRawOverrideToggle }: {
  turn: TranscriptTurn
  agentLabel: string
  working: boolean
  workingStartedAt: number | null
  canContinue: boolean
  onContinue?: () => void
  cwd: string
  onOpenThread?: (threadId: string) => void
  onFork?: (turnId: string) => void
  forking: boolean
  rawOverrides?: ReadonlySet<string>
  onRawOverrideToggle?: (messageKey: string) => void
}) {
  const processRows = turn.processRows.filter(isRenderableProcessRow)
  const finalRawKey = turn.finalRows.length > 0 ? messageRawKey(turn.finalRows[0].entry) : null
  const finalRawActive = finalRawKey !== null && (rawOverrides?.has(finalRawKey) ?? false)
  return (
    <section className={`conversation-turn${working ? ' running' : ''}`} data-turn-id={turn.turnId}>
      {turn.userRows.map((row, index) => (
        <ThreadItemView
          key={transcriptRowKey(row, index)}
          entry={row.entry}
          rawMode={false}
          rawOverrides={rawOverrides}
          onRawOverrideToggle={onRawOverrideToggle}
          cwd={cwd}
          agentLabel={agentLabel}
          onOpenThread={onOpenThread}
        />
      ))}
      {(processRows.length > 0 || turn.finalRows.length > 0) && (
        <div className="assistant-turn">
          {processRows.length > 0 && (
            <ProcessGroup
              rows={processRows}
              agentLabel={agentLabel}
              status={turn.status}
              hasFinalAnswer={turn.finalRows.length > 0}
              working={working}
              workingStartedAt={workingStartedAt}
              cwd={cwd}
              onOpenThread={onOpenThread}
            />
          )}
          {turn.finalRows.length > 0 && (
            <section className="final-answer" aria-label={`${agentLabel} 最终回答`}>
              <div className="final-answer-heading">
                <span><Bot size={15} />{agentLabel}</span>
                <small>最终回答</small>
              </div>
              {turn.finalRows.map((row, index) => (
                <ThreadItemView
                  key={transcriptRowKey(row, index)}
                  entry={row.entry}
                  agentText={row.agentText}
                  showAgentLabel={false}
                  rawMode={false}
                  rawOverrides={rawOverrides}
                  onRawOverrideToggle={onRawOverrideToggle}
                  cwd={cwd}
                  agentLabel={agentLabel}
                  onOpenThread={onOpenThread}
                />
              ))}
              {working && <WorkingStatus startedAt={workingStartedAt} />}
              {!working && turn.status !== 'inProgress' && (
                <MessageActions
                  copyText={copyableTranscriptText(turn.finalRows)}
                  onFork={onFork ? () => onFork(turn.turnId) : undefined}
                  forking={forking}
                  rawActive={finalRawActive}
                  onToggleRaw={finalRawKey !== null && onRawOverrideToggle ? () => onRawOverrideToggle(finalRawKey) : undefined}
                />
              )}
            </section>
          )}
        </div>
      )}
      {turn.status === 'failed' && <TurnFailureNotice error={turn.error} agentLabel={agentLabel} canContinue={canContinue} onContinue={onContinue} />}
    </section>
  )
}

function TurnFailureNotice({ error, agentLabel = 'Codex', canContinue, onContinue }: {
  error: Turn['error'] | undefined
  agentLabel?: string
  canContinue: boolean
  onContinue?: () => void
}) {
  const reason = error?.message?.trim() || `${agentLabel} 未返回更具体的失败原因。`
  return (
    <article className="turn-failure-notice" role="alert">
      <div className="turn-failure-copy">
        <span><CircleAlert size={15} />执行失败</span>
        <p>{reason}</p>
      </div>
      {canContinue && onContinue && (
        <button type="button" onClick={onContinue} title="在当前会话中新开一轮并发送“继续”；不会重试上一条请求。">继续</button>
      )}
    </article>
  )
}

function ProcessGroup({ rows, agentLabel, status, hasFinalAnswer, working, workingStartedAt, cwd, onOpenThread }: {
  rows: TranscriptItem[]
  agentLabel: string
  status: Turn['status'] | undefined
  hasFinalAnswer: boolean
  working: boolean
  workingStartedAt: number | null
  cwd: string
  onOpenThread?: (threadId: string) => void
}) {
  const keepOpen = working || !hasFinalAnswer || status === 'failed' || status === 'interrupted'
  const [open, setOpen] = useState(keepOpen)

  useEffect(() => {
    if (keepOpen) setOpen(true)
    else setOpen(false)
  }, [keepOpen])

  const state = working ? 'running' : status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed'
  return (
    <section className={`process-group ${state}`}>
      <button type="button" className="process-group-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="process-group-title">{working ? `${agentLabel} 正在执行` : status === 'failed' ? '执行失败' : status === 'interrupted' ? '执行已中断' : '执行过程'}</span>
        <span className="process-group-summary">{summarizeProcessRows(rows)}</span>
        {state !== 'completed' && <small>{state === 'running' ? '运行中' : state === 'failed' ? '失败' : '已中断'}</small>}
      </button>
      {open && (
        <div className="process-group-body">
          {rows.map((row, index) => (
            <ThreadItemView
              key={transcriptRowKey(row, index)}
              entry={row.entry}
              agentText={row.agentText}
              showAgentLabel={false}
              rawMode={false}
              cwd={cwd}
              agentLabel={agentLabel}
              onOpenThread={onOpenThread}
            />
          ))}
          {working && <WorkingStatus startedAt={workingStartedAt} />}
        </div>
      )}
    </section>
  )
}

function isRenderableProcessRow(row: TranscriptItem): boolean {
  return !['reasoning', 'rawResponse', 'internal'].includes(row.entry.item.type)
}

export const CHOOSE_WORKSPACE_VALUE = '__choose_workspace__'

export function isChooseWorkspaceSelection(value: string): boolean {
  return value === CHOOSE_WORKSPACE_VALUE
}

const ThreadItemView = memo(function ThreadItemView({
  entry,
  agentText,
  showAgentLabel = true,
  agentLabel = 'Codex',
  rawMode,
  rawOverrides,
  onRawOverrideToggle,
  workingStartedAt,
  cwd,
  onOpenThread,
}: {
  entry: ThreadItemEntry
  agentText?: string
  showAgentLabel?: boolean
  agentLabel?: string
  rawMode: boolean
  rawOverrides?: ReadonlySet<string>
  onRawOverrideToggle?: (messageKey: string) => void
  workingStartedAt?: number | null
  cwd: string
  onOpenThread?: (threadId: string) => void
}) {
  const { item } = entry
  const rawKey = messageRawKey(entry)
  const rawActive = rawKey !== null && (rawOverrides?.has(rawKey) ?? false)
  // Global /raw and the per-message toggle are independent: either one turns
  // this message raw. Last writer wins is per-message because each toggle only
  // ever flips its own key.
  const effectiveRaw = rawMode || rawActive
  const rawToggle = rawKey !== null && onRawOverrideToggle
    ? () => onRawOverrideToggle(rawKey)
    : undefined
  if (item.type === 'userMessage') {
    const text = itemText(item)
    const attachments = (item.content ?? []).filter((content) => content.type === 'localImage' || content.type === 'image' || content.type === 'mention')
    return text || attachments.length ? (
      <article className="message user-message">
        <div className="message-label"><UserRound size={14} />你</div>
        <div className="user-bubble">
          {text && (effectiveRaw
            ? <pre className="raw-response">{text}</pre>
            : <div>{text}</div>)}
          {attachments.length > 0 && <div className="user-attachments">{attachments.map((attachment, index) => {
            const path = attachment.type === 'image' ? attachment.url : attachment.path
            const name = attachment.type === 'mention' ? attachment.name : path.split(/[\\/]/).pop() || path
            return <span key={`${path}:${index}`} title={path}>{attachment.type === 'mention' ? <FileText size={13} /> : <Image size={13} />}{name}</span>
          })}</div>}
        </div>
        {text && <MessageActions copyText={text} rawActive={rawActive} onToggleRaw={rawToggle} />}
      </article>
    ) : null
  }
  if (item.type === 'agentMessage') {
    return (
      <article className="message agent-message">
        {showAgentLabel && <div className="message-label"><Bot size={15} />{agentLabel}</div>}
        <MessageBody text={agentText ?? item.text ?? ''} raw={effectiveRaw} cwd={cwd} />
        {workingStartedAt !== undefined && <WorkingStatus startedAt={workingStartedAt} />}
      </article>
    )
  }
  if (item.type === 'plan') {
    return (
      <article className="message plan-message">
        <div className="message-label"><Command size={14} />计划</div>
        <MessageBody text={item.text ?? ''} raw={rawMode} cwd={cwd} />
      </article>
    )
  }
  if (item.type === 'commandExecution') return <CommandItem item={item} />
  if (item.type === 'fileChange') return <FileChangeItem item={item} cwd={cwd} />
  if (item.type === 'mcpToolCall') return <McpItem item={item} />
  if (item.type === 'collabAgentToolCall') return <CollabAgentItem item={item} onOpenThread={onOpenThread} />
  if (['reasoning', 'rawResponse', 'internal'].includes(item.type)) return null
  return <GenericActivityItem item={item} />
})

function MessageActions({ copyText, onFork, forking = false, rawActive = false, onToggleRaw }: {
  copyText?: string
  onFork?: () => void
  forking?: boolean
  rawActive?: boolean
  onToggleRaw?: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const canCopy = Boolean(copyText?.trim())
  if (!canCopy && !onFork && !onToggleRaw) return null

  const copy = async () => {
    if (!copyText) return
    try {
      await writeClipboard(copyText)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 1_500)
  }

  return (
    <div className="message-actions">
      {canCopy && (
        <button type="button" className={copyState} onClick={() => void copy()} aria-label="复制消息" data-tip="copy">
          {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
      {onToggleRaw && (
        <button type="button" className={rawActive ? 'active' : undefined} onClick={onToggleRaw} aria-label={rawActive ? '恢复富文本渲染' : '以原始文本显示此消息'} aria-pressed={rawActive} data-tip="raw">
          <FileCode2 size={13} />
        </button>
      )}
      {onFork && (
        <button type="button" onClick={onFork} disabled={forking} aria-label="从此处开始分叉" data-tip="fork">
          <GitFork size={13} />
        </button>
      )}
    </div>
  )
}

export function copyableTranscriptText(rows: TranscriptItem[]): string {
  return rows
    .map((row) => row.agentText ?? row.entry.item.text ?? '')
    .filter((text) => text.trim().length > 0)
    .join('\n\n')
}

function GenericActivityItem({ item }: { item: ThreadItemEntry['item'] }) {
  const labels: Record<string, string> = {
    webSearch: '网页搜索',
    dynamicToolCall: '工具调用',
    collabAgentToolCall: '协作 Agent',
    imageGeneration: '图片生成',
    imageView: '查看图片',
    contextCompaction: '整理上下文',
    enteredReviewMode: '进入代码审查',
    exitedReviewMode: '完成代码审查',
  }
  return (
    <article className="tool-card activity-card">
      <div className="tool-card-head static-head">
        <Wrench size={14} />
        <span>{labels[item.type] ?? `活动：${item.type}`}</span>
        <span>{item.status ?? ''}</span>
      </div>
    </article>
  )
}

function MessageBody({ text, raw, cwd }: { text: string; raw: boolean; cwd: string }) {
  if (raw) return <pre className="raw-response">{text}</pre>
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (props) => <MarkdownLink {...props} cwd={cwd} />, pre: MarkdownCodeBlock }}>{text}</ReactMarkdown>
    </div>
  )
}

function MarkdownCodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    const text = preRef.current?.textContent ?? ''
    if (!text) return
    try {
      await writeClipboard(text.replace(/\n$/, ''))
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1_500)
    } catch {
      setCopyState('failed')
      window.setTimeout(() => setCopyState('idle'), 1_500)
    }
  }

  return (
    <div className="markdown-code-block">
      <pre ref={preRef} {...props}>{children}</pre>
      <button type="button" className={copyState} onClick={() => void copy()} aria-label="复制代码" title={copyState === 'failed' ? '复制失败' : '复制代码'}>
        {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '失败' : '复制'}
      </button>
    </div>
  )
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('clipboard unavailable')
}

function MarkdownLink({ href, children, cwd, ...props }: ComponentPropsWithoutRef<'a'> & { cwd: string }) {
  const local = href ? parseLocalFileReference(href) : null
  if (local) return (
    <button
      type="button"
      className="local-link"
      title={`在 GoLand 中打开 ${local.path}${local.line ? `:${local.line}` : ''}`}
      onClick={() => void runtime.openWorkspacePath('goland', cwd, local.path, local.line).catch(() => undefined)}
    >
      {children}
    </button>
  )
  if (!href || !isExternalWebUrl(href)) return <span className="local-link-label" title={href}>{children || href}</span>
  const showDestination = markdownLinkLabel(children) !== href
  return (
    <a
      href={href}
      {...props}
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault()
        void runtime.openExternalUrl(href).catch(() => undefined)
      }}
    >
      {children}{showDestination && <span className="link-destination"> ({href})</span>}
    </a>
  )
}

export interface LocalFileReference {
  path: string
  line?: number
}

export function parseLocalFileReference(value: string): LocalFileReference | null {
  let decoded: string
  try {
    decoded = decodeURI(value)
  } catch {
    return null
  }
  if (decoded.startsWith('file://')) {
    try {
      const url = new URL(decoded)
      decoded = decodeURIComponent(url.pathname) + url.hash
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null
  const hashLine = decoded.match(/^(.*)#L(\d+)$/)
  if (hashLine) return { path: hashLine[1], line: positiveLine(hashLine[2]) }
  const suffixLine = decoded.match(/^(.*?):(\d+)(?::\d+)?$/)
  if (suffixLine) return { path: suffixLine[1], line: positiveLine(suffixLine[2]) }
  if (decoded.startsWith('/') || decoded.startsWith('./') || decoded.startsWith('../') || /^[\w@.-]+\//.test(decoded)) {
    return { path: decoded }
  }
  return null
}

function positiveLine(value: string): number | undefined {
  const line = Number(value)
  return Number.isSafeInteger(line) && line > 0 ? line : undefined
}

function markdownLinkLabel(children: ComponentPropsWithoutRef<'a'>['children']): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(markdownLinkLabel).join('')
  return ''
}

export function isExternalWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function CommandItem({ item }: { item: ThreadItemEntry['item'] }) {
  const [open, setOpen] = useState(false)
  const rawCommand = String(item.command ?? '命令')
  const command = displayCommand(rawCommand)
  const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
  return (
    <article className={`tool-card command-card ${item.status === 'failed' ? 'failed' : ''}`}>
      <button type="button" className="tool-card-head" onClick={() => setOpen((value) => !value)}>
        <Terminal size={15} />
        <code title={rawCommand}>{truncate(command, 110)}</code>
        <span>{item.status === 'inProgress' ? '运行中' : item.exitCode === 0 ? '完成' : item.status ?? ''}</span>
        {item.durationMs !== undefined && <small>{formatDuration(item.durationMs)}</small>}
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open && (
        <div className="tool-card-body">
          {item.cwd && <p className="tool-cwd">{String(item.cwd)}</p>}
          {output ? <pre>{output}</pre> : <p className="tool-empty">暂无可展示的输出</p>}
        </div>
      )}
    </article>
  )
}

function FileChangeItem({ item, cwd }: { item: ThreadItemEntry['item']; cwd: string }) {
  const [open, setOpen] = useState(false)
  const changes = Array.isArray(item.changes) ? item.changes : []
  return (
    <article className="tool-card file-card">
      <button type="button" className="tool-card-head" onClick={() => setOpen((value) => !value)}>
        <FileCode2 size={15} />
        <span>{changes.length ? `修改了 ${changes.length} 个文件` : '文件修改'}</span>
        <span>{item.status === 'inProgress' ? '应用中' : item.status ?? ''}</span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open && (
        <div className="tool-card-body file-list">
          {changes.length ? changes.map((change, index) => {
            const path = String(change.path ?? '')
            return path ? (
              <button key={`${path}:${index}`} type="button" onClick={() => void runtime.openWorkspacePath('goland', cwd, path).catch(() => undefined)} title="在 GoLand 中打开">
                <code>{path}</code>
              </button>
            ) : <code key={`unknown:${index}`}>未知文件</code>
          }) : <p className="tool-empty">App Server 未提供可展示的文件列表</p>}
        </div>
      )}
    </article>
  )
}

function CollabAgentItem({ item, onOpenThread }: { item: ThreadItemEntry['item']; onOpenThread?: (threadId: string) => void }) {
  const receiverIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
  const states = item.agentsStates ?? {}
  const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
  return (
    <article className={`tool-card agent-activity-card ${item.status === 'failed' ? 'failed' : ''}`}>
      <div className="tool-card-head static-head">
        <GitFork size={14} />
        <span>{collabToolLabel(item.tool)}</span>
        <span>{activityStatusLabel(item.status)}</span>
      </div>
      {(prompt || receiverIds.length > 0) && (
        <div className="tool-card-body agent-activity-body">
          {prompt && <p>{truncate(prompt, 180)}</p>}
          {receiverIds.map((threadId) => {
            const state = states[threadId]
            return (
              <button key={threadId} type="button" onClick={() => onOpenThread?.(threadId)} disabled={!onOpenThread} title="打开子 Agent 会话">
                <span>{threadId.slice(0, 12)}</span>
                <small>{activityStatusLabel(state?.status)}</small>
                {state?.message && <em>{truncate(state.message, 80)}</em>}
              </button>
            )
          })}
        </div>
      )}
    </article>
  )
}

export function collabToolLabel(tool: unknown): string {
  const labels: Record<string, string> = {
    spawnAgent: '启动子 Agent', sendInput: '发送子 Agent 输入', resumeAgent: '恢复子 Agent', wait: '等待子 Agent',
    closeAgent: '关闭子 Agent', sendMessage: '通知子 Agent', followupTask: '追加子 Agent 任务', interruptAgent: '中断子 Agent', listAgents: '查看 Agent',
  }
  return labels[String(tool)] ?? '协作 Agent'
}

export function activityStatusLabel(status: unknown): string {
  const labels: Record<string, string> = {
    pendingInit: '初始化中', inProgress: '进行中', running: '运行中', completed: '已完成', failed: '失败', errored: '出错', interrupted: '已中断', shutdown: '已关闭', notFound: '未找到',
  }
  return labels[String(status)] ?? String(status ?? '')
}

function McpItem({ item }: { item: ThreadItemEntry['item'] }) {
  return (
    <article className="tool-card mcp-card">
      <div className="tool-card-head static-head">
        <Command size={15} />
        <span>{String(item.server ?? 'MCP')} / {String(item.tool ?? '工具')}</span>
        <span>{item.status ?? ''}</span>
      </div>
    </article>
  )
}

function ApprovalCard({ request, onAnswer }: { request: ApprovalRequest; onAnswer: (request: ApprovalRequest, decision: unknown) => void }) {
  const params = request.params
  const command = typeof params.command === 'string'
    ? params.command
    : Array.isArray(params.command) ? params.command.join(' ') : null
  const displayedCommand = command ? displayCommand(command) : null
  const reason = typeof params.reason === 'string' ? params.reason : null
  const decisions = request.method === 'item/commandExecution/requestApproval'
    ? Array.isArray(params.availableDecisions) && params.availableDecisions.length > 0 ? params.availableDecisions : ['accept', 'decline']
    : request.method === 'item/fileChange/requestApproval' ? ['accept', 'decline']
      : request.method === 'item/tool/requestUserInput' ? ['cancel'] : ['accept', 'decline']
  return (
    <article className="approval-card">
      <div className="approval-icon"><ShieldAlert size={18} /></div>
      <div className="approval-content">
        <h3>{request.method === 'item/fileChange/requestApproval' ? '需要确认文件修改' : request.method === 'item/tool/requestUserInput' ? 'Codex 需要你的输入' : '需要执行审批'}</h3>
        {displayedCommand && <code title={command ?? undefined}>{displayedCommand}</code>}
        {reason && <p>{reason}</p>}
        {!command && !reason && <p>App Server 请求确认该操作。</p>}
        <div className="approval-actions">
          {decisions.map((decision) => {
            const label = approvalLabel(decision)
            const accepting = ['accept', 'acceptForSession', 'approved'].includes(String(decision))
            return <button key={String(decision)} type="button" className={accepting ? 'approve' : 'deny'} onClick={() => onAnswer(request, decision)}>{label}</button>
          })}
        </div>
      </div>
    </article>
  )
}

function approvalLabel(value: unknown): string {
  if (value === 'accept') return '允许一次'
  if (value === 'acceptForSession') return '本会话允许'
  if (value === 'decline') return '拒绝'
  if (value === 'cancel') return '取消'
  return '确认'
}
