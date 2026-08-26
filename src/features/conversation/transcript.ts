import type { ThreadItemEntry } from '../../core/domain/codex'

export interface TranscriptItem {
  entry: ThreadItemEntry
  agentText?: string
  showAgentLabel?: boolean
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
    const previous = rows.at(-1)
    if (previous?.agentText !== undefined && previous.entry.turnId === entry.turnId) {
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
    })
    labeledTurns.add(entry.turnId)
  }

  return rows
}

function joinAgentText(left: string, right: string): string {
  if (!left) return right
  if (!right) return left
  return `${left}\n\n${right}`
}
