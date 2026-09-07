import { describe, expect, it } from 'vitest'
import type { ThreadItemEntry } from '../../core/domain/codex'
import {
  DEFAULT_ARCHIVE_PROMPT_TEMPLATE,
  collectArchiveMessages,
  renderArchivePrompt,
  renderArchiveTranscript,
} from './archive'

function entry(type: string, text: string, turnId = 't1'): ThreadItemEntry {
  if (type === 'userMessage') {
    return { turnId, item: { type, content: [{ type: 'text', text, text_elements: [] }] } }
  }
  return { turnId, item: { type, text } }
}

describe('collectArchiveMessages', () => {
  it('keeps user and agent messages, drops noise', () => {
    const items = [
      entry('userMessage', '做 X'),
      entry('commandExecution', 'ls -la'),
      entry('agentMessage', '已完成 X'),
      entry('mcpToolCall', 'tool output'),
      entry('fileChange', ''),
      entry('userMessage', '再做 Y'),
      entry('agentMessage', 'Y 完成'),
    ]
    expect(collectArchiveMessages(items, 10)).toEqual([
      { role: 'user', text: '做 X' },
      { role: 'agent', text: '已完成 X' },
      { role: 'user', text: '再做 Y' },
      { role: 'agent', text: 'Y 完成' },
    ])
  })

  it('drops empty texts', () => {
    const items = [entry('userMessage', '  '), entry('agentMessage', '')]
    expect(collectArchiveMessages(items, 10)).toEqual([])
  })

  it('limits to the most recent N turns (counted by user messages)', () => {
    const items = [
      entry('userMessage', 'u1'),
      entry('agentMessage', 'a1'),
      entry('userMessage', 'u2'),
      entry('agentMessage', 'a2'),
      entry('userMessage', 'u3'),
      entry('agentMessage', 'a3'),
    ]
    expect(collectArchiveMessages(items, 2)).toEqual([
      { role: 'user', text: 'u2' },
      { role: 'agent', text: 'a2' },
      { role: 'user', text: 'u3' },
      { role: 'agent', text: 'a3' },
    ])
  })

  it('returns all when maxTurns <= 0', () => {
    const items = [entry('userMessage', 'u1'), entry('userMessage', 'u2')]
    expect(collectArchiveMessages(items, 0)).toHaveLength(2)
  })
})

describe('renderArchiveTranscript', () => {
  it('renders role-labeled transcript', () => {
    const out = renderArchiveTranscript([
      { role: 'user', text: 'hi' },
      { role: 'agent', text: 'hello' },
    ])
    expect(out).toContain('用户：\nhi')
    expect(out).toContain('Agent：\nhello')
  })
})

describe('renderArchivePrompt', () => {
  it('fills placeholders and leaves unknown ones intact', () => {
    const out = renderArchivePrompt({
      template: 'S={{currentStatus}} T={{transcript}} U={{unknown}}',
      currentStatus: 'old',
      transcript: 'log',
    })
    expect(out).toBe('S=old T=log U={{unknown}}')
  })

  it('default template contains both placeholders', () => {
    expect(DEFAULT_ARCHIVE_PROMPT_TEMPLATE).toContain('{{currentStatus}}')
    expect(DEFAULT_ARCHIVE_PROMPT_TEMPLATE).toContain('{{transcript}}')
  })
})
