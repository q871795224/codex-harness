import { Bot, Command, FileCode2, MessageSquareText, Terminal, Wrench } from 'lucide-react'
import type { ThreadItemEntry } from '../../core/domain/codex'
import { itemText } from '../../core/domain/codex'
import { formatDuration, truncate } from '../../core/domain/format'

export function TrajectoryView({ items }: { items: ThreadItemEntry[] }) {
  const visible = items.filter((entry) => !['reasoning', 'rawResponse'].includes(entry.item.type))
  if (visible.length === 0) {
    return <div className="trajectory-empty">这里会显示 App Server 已公开的回合、消息、命令和文件修改。</div>
  }
  return (
    <div className="trajectory-scroll">
      <ol className="trajectory-list">
        {visible.map((entry, index) => <TrajectoryItem key={`${entry.turnId}:${entry.item.id ?? index}`} entry={entry} />)}
      </ol>
    </div>
  )
}

function TrajectoryItem({ entry }: { entry: ThreadItemEntry }) {
  const { item } = entry
  const data = trajectoryCopy(item)
  if (!data) return null
  return (
    <li className={`trajectory-item ${data.kind}`}>
      <span className="trajectory-icon">{data.icon}</span>
      <div className="trajectory-content">
        <div className="trajectory-title"><span>{data.label}</span>{data.meta && <small>{data.meta}</small>}</div>
        {data.detail && <code>{data.detail}</code>}
      </div>
    </li>
  )
}

function trajectoryCopy(item: ThreadItemEntry['item']): { icon: JSX.Element; label: string; detail?: string; meta?: string; kind: string } | null {
  if (item.type === 'userMessage') return { icon: <MessageSquareText size={14} />, label: '用户消息', detail: truncate(itemText(item), 180), kind: 'message' }
  if (item.type === 'agentMessage') return { icon: <Bot size={14} />, label: 'Codex 回复', detail: truncate(item.text ?? '', 180), kind: 'agent' }
  if (item.type === 'commandExecution') return {
    icon: <Terminal size={14} />, label: item.status === 'inProgress' ? '正在执行命令' : '执行命令', detail: truncate(String(item.command ?? ''), 180), meta: formatDuration(item.durationMs), kind: 'command',
  }
  if (item.type === 'fileChange') return { icon: <FileCode2 size={14} />, label: `文件修改${Array.isArray(item.changes) ? ` · ${item.changes.length} 项` : ''}`, kind: 'files' }
  if (item.type === 'mcpToolCall') return { icon: <Wrench size={14} />, label: '调用 MCP 工具', detail: `${String(item.server ?? '')} / ${String(item.tool ?? '')}`, meta: String(item.status ?? ''), kind: 'tool' }
  if (item.type === 'plan') return { icon: <Command size={14} />, label: '计划更新', detail: truncate(item.text ?? '', 180), kind: 'plan' }
  return null
}
