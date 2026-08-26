import { describe, expect, it } from 'vitest'
import { isActive, itemText, queueText, textInput, threadTitle, type Thread } from './codex'

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    preview: '默认预览',
    cwd: '/workspace',
    name: null,
    createdAt: 0,
    updatedAt: 0,
    recencyAt: null,
    status: { type: 'idle' },
    ephemeral: false,
    canAcceptDirectInput: true,
    ...overrides,
  }
}

describe('threadTitle', () => {
  it('prefers a non-empty user supplied name', () => {
    expect(threadTitle(makeThread({ name: '  修复登录问题  ' }))).toBe('修复登录问题')
  })

  it('falls back to preview and then the new-thread label', () => {
    expect(threadTitle(makeThread({ name: ' ', preview: '首次请求' }))).toBe('首次请求')
    expect(threadTitle(makeThread({ name: null, preview: '  ' }))).toBe('新会话')
  })
})

describe('thread content helpers', () => {
  it('extracts user text in message order', () => {
    expect(itemText({ type: 'userMessage', content: [textInput('第一段'), textInput('第二段')] })).toBe('第一段\n第二段')
  })

  it('uses text for non-user items and joins queued inputs', () => {
    expect(itemText({ type: 'agentMessage', text: '回复内容' })).toBe('回复内容')
    expect(queueText({ id: 'queue-1', input: [textInput('继续'), textInput('执行')], clientUserMessageId: 'message-1' })).toBe('继续\n执行')
  })
})

describe('isActive', () => {
  it('only treats active thread statuses as active', () => {
    expect(isActive({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe(true)
    expect(isActive({ type: 'idle' })).toBe(false)
  })
})
