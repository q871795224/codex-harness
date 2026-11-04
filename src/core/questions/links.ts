import type { UserInputQuestion } from '../domain/userInput'
import type { QuestionLocator } from './types'

export async function questionRevision(question: UserInputQuestion): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(question)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function parseQuestionLink(value: string): QuestionLocator {
  const url = new URL(value)
  if (url.protocol !== 'codex-harness:' || url.hostname !== 'question' || (url.pathname !== '' && url.pathname !== '/')
    || url.username || url.password || url.port || url.hash || value.length > 8192) throw new Error('无法识别这个 Harness 问题链接。')
  const allowed = ['thread', 'turn', 'request', 'kind', 'question', 'revision', 'option']
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error('问题链接包含无效参数。')
  }
  const get = (key: string) => {
    const value = url.searchParams.get(key)
    if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('问题链接缺少有效标识。')
    return value
  }
  const kind = get('kind')
  if (kind !== 'tool' && kind !== 'async') throw new Error('未知的提问类型。')
  const revision = get('revision')
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('问题链接版本无效。')
  const rawOption = url.searchParams.get('option')
  if (rawOption !== null && !/^(0|[1-9]\d{0,3})$/.test(rawOption)) throw new Error('答案选项无效。')
  return { thread: get('thread'), turn: get('turn'), request: get('request'), kind,
    question: get('question'), revision, ...(rawOption === null ? {} : { option: Number(rawOption) }) }
}
