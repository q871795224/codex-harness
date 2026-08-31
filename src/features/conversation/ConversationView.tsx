import { memo, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  Copy,
  FileCode2,
  FileText,
  GitBranch,
  Image,
  Pencil,
  Pin,
  PinOff,
  ShieldAlert,
  Terminal,
  UserRound,
  Wrench,
} from 'lucide-react'
import type { ApprovalRequest, Thread, ThreadItemEntry, Turn, Workspace } from '../../core/domain/codex'
import { itemText, threadTitle } from '../../core/domain/codex'
import { formatDuration, truncate } from '../../core/domain/format'
import { groupTranscriptTurns, summarizeProcessRows, type TranscriptItem, type TranscriptTurn } from './transcript'
import { runtime } from '../../core/runtime/bridge'
import { WorkingStatus } from './ConversationStats'

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
  headerActions?: ReactNode
}

export function ConversationHeader({ thread, workspace, gitContextResolved, archived, pinned, workspaceChanging, canChangeWorkspace, onRename, onArchive, onUnarchive, onTogglePinned, onChooseWorkspace, headerActions }: ConversationHeaderProps) {
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
  items: ThreadItemEntry[]
  turns: Turn[]
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
  newThreadPanels?: ReactNode
  rawMode: boolean
  working: boolean
  workingTurnId: string | null
  workingStartedAt: number | null
  onRawModeToggle: () => void
}

export function ConversationView({ items, turns, approvals, workspace, workspaces, workspaceChanging, initialScrollTop, scrollToLatestRequest, hasOlderTurns, loadingOlderTurns, onAnswerApproval, onLoadOlderTurns, onScrollPosition, onWorkspaceChange, onChooseWorkspace, newThreadPanels, rawMode, working, workingTurnId, workingStartedAt, onRawModeToggle }: ConversationViewProps) {
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
  const turnStatuses: Record<string, Turn['status']> = Object.fromEntries(turns.map((turn) => [turn.id, turn.status]))
  if (workingTurnId) turnStatuses[workingTurnId] = 'inProgress'
  const transcriptTurns = rawMode ? [] : groupTranscriptTurns(items, turnStatuses)
  const workingMessageIndex = rawMode && working ? latestAgentMessageIndex(rawTranscriptRows, workingTurnId) : -1
  const activeTurnHasContent = transcriptTurns.some((turn) => turn.turnId === workingTurnId && (turn.processRows.length > 0 || turn.finalRows.length > 0))

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
                  开启一段新的 Codex 会话吧。
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
              workingStartedAt={index === workingMessageIndex ? workingStartedAt : undefined}
            />
          )) : transcriptTurns.map((turn) => (
            <TranscriptTurnView
              key={turn.turnId}
              turn={turn}
              working={working && turn.turnId === workingTurnId}
              workingStartedAt={workingStartedAt}
            />
          ))}
          {working && (rawMode ? workingMessageIndex < 0 : !activeTurnHasContent) && (
            <article className="message agent-message working-message">
              <div className="message-label"><Bot size={15} />Codex</div>
              <WorkingStatus startedAt={workingStartedAt} />
            </article>
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

function transcriptRowKey(row: TranscriptItem, index: number): string {
  return `${row.entry.turnId}:${row.entry.item.id ?? index}`
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

function TranscriptTurnView({ turn, working, workingStartedAt }: { turn: TranscriptTurn; working: boolean; workingStartedAt: number | null }) {
  const processRows = turn.processRows.filter(isRenderableProcessRow)
  return (
    <section className={`conversation-turn${working ? ' running' : ''}`} data-turn-id={turn.turnId}>
      {turn.userRows.map((row, index) => (
        <ThreadItemView
          key={transcriptRowKey(row, index)}
          entry={row.entry}
          rawMode={false}
        />
      ))}
      {(processRows.length > 0 || turn.finalRows.length > 0) && (
        <div className="assistant-turn">
          {processRows.length > 0 && (
            <ProcessGroup
              rows={processRows}
              status={turn.status}
              hasFinalAnswer={turn.finalRows.length > 0}
              working={working}
              workingStartedAt={workingStartedAt}
            />
          )}
          {turn.finalRows.length > 0 && (
            <section className="final-answer" aria-label="Codex 最终回答">
              <div className="final-answer-heading">
                <span><Bot size={15} />Codex</span>
                <small>最终回答</small>
              </div>
              {turn.finalRows.map((row, index) => (
                <ThreadItemView
                  key={transcriptRowKey(row, index)}
                  entry={row.entry}
                  agentText={row.agentText}
                  showAgentLabel={false}
                  rawMode={false}
                />
              ))}
              {working && <WorkingStatus startedAt={workingStartedAt} />}
            </section>
          )}
        </div>
      )}
    </section>
  )
}

function ProcessGroup({ rows, status, hasFinalAnswer, working, workingStartedAt }: {
  rows: TranscriptItem[]
  status: Turn['status'] | undefined
  hasFinalAnswer: boolean
  working: boolean
  workingStartedAt: number | null
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
        <span className="process-group-title">{working ? 'Codex 正在执行' : status === 'failed' ? '执行失败' : status === 'interrupted' ? '执行已中断' : '执行过程'}</span>
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
  rawMode,
  workingStartedAt,
}: {
  entry: ThreadItemEntry
  agentText?: string
  showAgentLabel?: boolean
  rawMode: boolean
  workingStartedAt?: number | null
}) {
  const { item } = entry
  if (item.type === 'userMessage') {
    const text = itemText(item)
    const attachments = (item.content ?? []).filter((content) => content.type === 'localImage' || content.type === 'image' || content.type === 'mention')
    return text || attachments.length ? (
      <article className="message user-message">
        <div className="message-label"><UserRound size={14} />你</div>
        <div className="user-bubble">
          {text && <div>{text}</div>}
          {attachments.length > 0 && <div className="user-attachments">{attachments.map((attachment, index) => {
            const path = attachment.type === 'image' ? attachment.url : attachment.path
            const name = attachment.type === 'mention' ? attachment.name : path.split(/[\\/]/).pop() || path
            return <span key={`${path}:${index}`} title={path}>{attachment.type === 'mention' ? <FileText size={13} /> : <Image size={13} />}{name}</span>
          })}</div>}
        </div>
      </article>
    ) : null
  }
  if (item.type === 'agentMessage') {
    return (
      <article className="message agent-message">
        {showAgentLabel && <div className="message-label"><Bot size={15} />Codex</div>}
        <MessageBody text={agentText ?? item.text ?? ''} raw={rawMode} />
        {workingStartedAt !== undefined && <WorkingStatus startedAt={workingStartedAt} />}
      </article>
    )
  }
  if (item.type === 'plan') {
    return (
      <article className="message plan-message">
        <div className="message-label"><Command size={14} />计划</div>
        <MessageBody text={item.text ?? ''} raw={rawMode} />
      </article>
    )
  }
  if (item.type === 'commandExecution') return <CommandItem item={item} />
  if (item.type === 'fileChange') return <FileChangeItem item={item} />
  if (item.type === 'mcpToolCall') return <McpItem item={item} />
  if (['reasoning', 'rawResponse', 'internal'].includes(item.type)) return null
  return <GenericActivityItem item={item} />
})

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

function MessageBody({ text, raw }: { text: string; raw: boolean }) {
  if (raw) return <pre className="raw-response">{text}</pre>
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink, pre: MarkdownCodeBlock }}>{text}</ReactMarkdown>
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

function MarkdownLink({ href, children, ...props }: ComponentPropsWithoutRef<'a'>) {
  if (!href || !isExternalWebUrl(href)) return <span className="local-link" title={href}>{href || children}</span>
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
  const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
  return (
    <article className={`tool-card command-card ${item.status === 'failed' ? 'failed' : ''}`}>
      <button type="button" className="tool-card-head" onClick={() => setOpen((value) => !value)}>
        <Terminal size={15} />
        <code>{truncate(String(item.command ?? '命令'), 110)}</code>
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

function FileChangeItem({ item }: { item: ThreadItemEntry['item'] }) {
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
          {changes.length ? changes.map((change, index) => <code key={`${String(change.path)}:${index}`}>{String(change.path ?? '未知文件')}</code>) : <p className="tool-empty">App Server 未提供可展示的文件列表</p>}
        </div>
      )}
    </article>
  )
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
        {command && <code>{command}</code>}
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
