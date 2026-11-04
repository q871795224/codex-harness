import type { JsonObject, Turn } from '../../core/domain/codex'
import { itemText } from '../../core/domain/codex'
import { parseTitleResult } from './projectTitle'
import type { ProjectMeta } from '../project-doc/types'
import { eventThreadItem, eventTurn } from './conversationEventParser'

export interface TitleGeneratorState {
  targetThreadId: string
  attemptId: string
  text: string
  project?: ProjectMeta | null
  startedAt: number
}

export type TitleGeneratorEventResult =
  | { kind: 'pending'; state: TitleGeneratorState }
  | { kind: 'completed'; state: TitleGeneratorState; turn: Turn | null; generatedText: string; title: string | null }

export function reduceTitleGeneratorEvent(
  state: TitleGeneratorState,
  method: string,
  params: JsonObject,
): TitleGeneratorEventResult {
  if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
    return { kind: 'pending', state: { ...state, text: `${state.text}${params.delta}` } }
  }
  if (method === 'item/completed') {
    const item = eventThreadItem(params.item)
    const text = item?.type === 'agentMessage' ? itemText(item) : ''
    return { kind: 'pending', state: text ? { ...state, text } : state }
  }
  if (method === 'turn/completed') {
    const turn = eventTurn(params.turn)
    const fallback = turn?.items.find((item) => item.type === 'agentMessage')
    const generatedText = state.text || (fallback ? itemText(fallback) : '')
    return {
      kind: 'completed',
      state,
      turn,
      generatedText,
      title: parseTitleResult(generatedText, state.project ?? null).title,
    }
  }
  return { kind: 'pending', state }
}
