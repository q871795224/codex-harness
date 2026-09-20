import type { ThreadItemEntry, Turn } from '../../core/domain/codex'
import { itemText } from '../../core/domain/codex'
import { hasToolResult, inspectItem, inspectionText, toolItemTypes } from './itemInspection'

export interface TrajectoryRow {
  id: string
  entry: ThreadItemEntry
  turn: number
  step: number
  role: 'user' | 'assistant' | 'tool' | 'system' | 'developer' | 'event'
  kind: 'message' | 'call' | 'result' | 'event'
  name: string
  input: string
  output: string
}

export function trajectoryRows(items: ThreadItemEntry[], turns: Turn[] = []): TrajectoryRow[] {
  const turnIds = [...new Set([...turns.map((turn) => turn.id), ...items.map((entry) => entry.turnId)])]
  const steps = new Map<string, number>()
  const rows: TrajectoryRow[] = []
  for (const [index, entry] of items.entries()) {
    const { item, turnId } = entry
    if (['rawResponse', 'internal', 'reasoning'].includes(item.type)) continue
    const base = { entry, turn: turnIds.indexOf(turnId) + 1 }
    const append = (row: Omit<TrajectoryRow, 'id' | 'entry' | 'turn' | 'step'>) => {
      const step = (steps.get(turnId) ?? 0) + 1
      steps.set(turnId, step)
      rows.push({ ...base, ...row, step, id: `${turnId}:${item.id ?? index}:${row.kind}` })
    }
    if (toolItemTypes.has(item.type)) {
      const detail = inspectItem(item)
      // App Server coalesces the invocation and response. These are display projections,
      // not a claim that the original model wire messages have been captured.
      append({ role: item.source === 'userShell' ? 'user' : 'assistant', kind: 'call', name: detail.name, input: inspectionText(detail.input), output: '' })
      if (hasToolResult(item)) append({ role: 'tool', kind: 'result', name: detail.name, input: '', output: inspectionText(detail.output) })
    } else if (item.type === 'functionCallOutput') {
      append({ role: 'tool', kind: 'result', name: String(item.name ?? item.type), input: '', output: inspectionText(item.output) })
    } else {
      const role = item.type === 'userMessage' ? 'user' : ['agentMessage', 'plan'].includes(item.type) ? 'assistant'
        : ['user', 'assistant', 'tool', 'system', 'developer'].includes(String(item.role)) ? item.role as TrajectoryRow['role'] : 'event'
      const text = item.type === 'userMessage' ? itemText(item) || inspectionText(item.content) : item.text ?? inspectionText(item)
      append({ role, kind: role === 'event' ? 'event' : 'message', name: item.type, input: role === 'user' || role === 'system' || role === 'developer' ? text : '', output: role === 'assistant' || role === 'tool' || role === 'event' ? text : '' })
    }
  }
  return rows
}

export interface TimelineSegment { rowId: string; lane: 'input' | 'model' | 'tool'; left: number; width: number; measured: boolean }
export function trajectoryTimeline(rows: TrajectoryRow[]): { segments: TimelineSegment[]; timed: boolean } {
  const entries = rows.filter((row) => row.kind !== 'result' || row.entry.item.type === 'functionCallOutput')
  const complete = entries.length > 0 && entries.every(({ entry }) => entry.timing?.startedAt != null && entry.timing?.completedAt != null && entry.timing.completedAt >= entry.timing.startedAt)
  const start = complete ? Math.min(...entries.map(({ entry }) => entry.timing!.startedAt!)) : 0
  const end = complete ? Math.max(...entries.map(({ entry }) => entry.timing!.completedAt!)) : 0
  const timed = complete && end > start
  return { timed, segments: entries.map((row, index) => ({
    rowId: row.id,
    lane: row.kind === 'call' || row.role === 'tool' ? 'tool' : row.role === 'assistant' ? 'model' : 'input',
    left: timed ? (row.entry.timing!.startedAt! - start) / (end - start) * 100 : index / entries.length * 100,
    width: timed ? Math.max(0.15, (row.entry.timing!.completedAt! - row.entry.timing!.startedAt!) / (end - start) * 100) : 90 / entries.length,
    measured: timed,
  })) }
}
