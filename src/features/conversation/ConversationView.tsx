import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  Archive,
  ArchiveRestore,
  Bot,
  ChevronDown,
  ChevronRight,
  Command,
  FileCode2,
  GitBranch,
  Pencil,
  ShieldAlert,
  Terminal,
  UserRound,
} from 'lucide-react'
import type { ApprovalRequest, Thread, ThreadItemEntry, Workspace } from '../../core/domain/codex'
import { itemText, threadTitle } from '../../core/domain/codex'
import { formatDuration, truncate } from '../../core/domain/format'

interface ConversationHeaderProps {
  thread: Thread
  workspace: Workspace | null
  archived: boolean
  onRename: (name: string) => void
  onArchive: () => void
  onUnarchive: () => void
}

export function ConversationHeader({ thread, workspace, archived, onRename, onArchive, onUnarchive }: ConversationHeaderProps) {
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
              if (event.key === 'Escape') {
                setTitle(threadTitle(thread))
                setEditingTitle(false)
              }
              if (event.key === 'Enter') saveTitle()
            }}
          />
        ) : (
          <button className="thread-title-button" type="button" onClick={() => setEditingTitle(true)} title="重命名会话">
            <h1>{threadTitle(thread)}</h1>
            <Pencil size={15} />
          </button>
        )}
        <div className="thread-context">
          <span><GitBranch size={13} />{workspace?.name ?? '未分组'}</span>
          {thread.gitInfo?.branch && <span>{thread.gitInfo.branch}</span>}
          <span className="thread-path" title={thread.cwd}>{thread.cwd}</span>
        </div>
      </div>
      <button
        type="button"
        className="header-action"
        onClick={archived ? onUnarchive : onArchive}
        title={archived ? '恢复会话' : '归档会话'}
      >
        {archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
        {archived ? '恢复' : '归档'}
      </button>
    </header>
  )
}

interface ConversationViewProps {
  items: ThreadItemEntry[]
  approvals: ApprovalRequest[]
  workspace: Workspace | null
  hasOlderTurns: boolean
  loadingOlderTurns: boolean
  onAnswerApproval: (request: ApprovalRequest, decision: unknown) => void
  onLoadOlderTurns: () => void
}

export function ConversationView({ items, approvals, workspace, hasOlderTurns, loadingOlderTurns, onAnswerApproval, onLoadOlderTurns }: ConversationViewProps) {
  return (
    <div className="conversation-scroll">
      <div className="message-column">
        {hasOlderTurns && (
          <button className="load-older-turns" type="button" onClick={onLoadOlderTurns} disabled={loadingOlderTurns}>
            {loadingOlderTurns ? '正在加载更早消息…' : '加载更早消息'}
          </button>
        )}
        {items.length === 0 && (
          <div className="fresh-thread">
            <div className="fresh-thread-mark"><Bot size={24} /></div>
            <h2>从这里开始</h2>
            <p>这是一条新的 Codex 会话。消息会在 <strong>{workspace?.name ?? '当前工作区'}</strong> 中运行。</p>
          </div>
        )}
        {items.map((entry, index) => <ThreadItemView key={`${entry.turnId}:${entry.item.id ?? index}`} entry={entry} />)}
        {approvals.map((request) => (
          <ApprovalCard key={String(request.id)} request={request} onAnswer={onAnswerApproval} />
        ))}
      </div>
    </div>
  )
}

const ThreadItemView = memo(function ThreadItemView({ entry }: { entry: ThreadItemEntry }) {
  const { item } = entry
  if (item.type === 'userMessage') {
    const text = itemText(item)
    return text ? (
      <article className="message user-message">
        <div className="message-label"><UserRound size={14} />你</div>
        <div className="user-bubble">{text}</div>
      </article>
    ) : null
  }
  if (item.type === 'agentMessage') {
    return (
      <article className="message agent-message">
        <div className="message-label"><Bot size={15} />Codex</div>
        <div className="markdown-body"><ReactMarkdown>{item.text ?? ''}</ReactMarkdown></div>
      </article>
    )
  }
  if (item.type === 'plan') {
    return (
      <article className="message plan-message">
        <div className="message-label"><Command size={14} />计划</div>
        <div className="markdown-body"><ReactMarkdown>{item.text ?? ''}</ReactMarkdown></div>
      </article>
    )
  }
  if (item.type === 'commandExecution') return <CommandItem item={item} />
  if (item.type === 'fileChange') return <FileChangeItem item={item} />
  if (item.type === 'mcpToolCall') return <McpItem item={item} />
  // Reasoning and internal raw response payloads intentionally do not enter the chat transcript.
  return null
})

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
