import type { ThreadItemEntry, Turn } from '../../core/domain/codex'

export interface TranscriptItem {
  entry: ThreadItemEntry
  agentText?: string
  showAgentLabel?: boolean
  phase?: 'commentary' | 'final_answer'
}

export interface TranscriptTurn {
  turnId: string
  status?: Turn['status']
  error?: Turn['error']
  userRows: TranscriptItem[]
  processRows: TranscriptItem[]
  finalRows: TranscriptItem[]
}

export function groupTranscriptItems(items: ThreadItemEntry[]): TranscriptItem[] {
  const rows: TranscriptItem[] = []
  const labeledTurns = new Set<string>()

  for (const entry of items) {
    if (entry.item.type !== 'agentMessage') {
      rows.push({ entry })
      continue
    }

    const text = typeof entry.item.text === 'string' ? entry.item.text : ''
    const phase = agentMessagePhase(entry)
    const previous = rows.at(-1)
    if (previous?.agentText !== undefined && previous.entry.turnId === entry.turnId && previous.phase === phase) {
      rows[rows.length - 1] = {
        ...previous,
        agentText: joinAgentText(previous.agentText, text),
      }
      continue
    }

    rows.push({
      entry,
      agentText: text,
      showAgentLabel: !labeledTurns.has(entry.turnId),
      phase,
    })
    labeledTurns.add(entry.turnId)
  }

  return rows
}

export function groupTranscriptTurns(
  items: ThreadItemEntry[],
  turnDetails: Array<Pick<Turn, 'id' | 'status' | 'error'>> = [],
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  const byId = new Map<string, TranscriptItem[]>()
  const detailById = new Map(turnDetails.map((turn) => [turn.id, turn]))

  const ensureTurn = (turnId: string) => {
    if (byId.has(turnId)) return
    const detail = detailById.get(turnId)
    byId.set(turnId, [])
    turns.push({ turnId, status: detail?.status, error: detail?.error, userRows: [], processRows: [], finalRows: [] })
  }

  for (const detail of turnDetails) ensureTurn(detail.id)

  for (const row of groupTranscriptItems(items)) {
    const turnId = row.entry.turnId
    ensureTurn(turnId)
    const existing = byId.get(turnId)
    existing?.push(row)
  }

  for (const turn of turns) {
    const rows = byId.get(turn.turnId) ?? []
    turn.userRows = rows.filter((row) => row.entry.item.type === 'userMessage')
    const assistantRows = rows.filter((row) => row.entry.item.type !== 'userMessage')
    turn.finalRows = assistantRows.filter((row) => row.phase === 'final_answer')

    if (turn.finalRows.length === 0 && canUseLegacyFinalFallback(turn.status)) {
      const legacyFinal = lastLegacyAgentRow(assistantRows)
      if (legacyFinal) turn.finalRows = [legacyFinal]
    }

    const finalRows = new Set(turn.finalRows)
    turn.processRows = assistantRows.filter((row) => !finalRows.has(row))
  }

  return turns
}

export function summarizeProcessRows(rows: TranscriptItem[]): string {
  const commandCount = rows.filter((row) => row.entry.item.type === 'commandExecution').length
  const fileCount = rows.reduce((count, row) => row.entry.item.type === 'fileChange' && Array.isArray(row.entry.item.changes)
    ? count + row.entry.item.changes.length
    : count, 0)
  return [
    `${rows.length} 项`,
    fileCount > 0 ? `修改 ${fileCount} 个文件` : null,
    commandCount > 0 ? `运行 ${commandCount} 条命令` : null,
  ].filter(Boolean).join(' · ')
}

function agentMessagePhase(entry: ThreadItemEntry): TranscriptItem['phase'] {
  return entry.item.phase === 'commentary' || entry.item.phase === 'final_answer' ? entry.item.phase : undefined
}

function canUseLegacyFinalFallback(status: Turn['status'] | undefined): boolean {
  return status !== 'inProgress' && status !== 'failed' && status !== 'interrupted'
}

function lastLegacyAgentRow(rows: TranscriptItem[]): TranscriptItem | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.agentText !== undefined && row.phase === undefined && row.agentText.trim()) return row
  }
  return undefined
}

function joinAgentText(left: string, right: string): string {
  if (!left) return right
  if (!right) return left
  return `${left}\n\n${right}`
}
