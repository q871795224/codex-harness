import { describe, expect, it } from 'vitest'
import { nextConversationProvider } from './conversationProvider'
describe('conversation provider icon cycle', () => {
  it('cycles Codex, Claude and Superbot', () => {
    expect(nextConversationProvider('codex', true)).toBe('claude')
    expect(nextConversationProvider('claude', true)).toBe('superbot')
    expect(nextConversationProvider('superbot', true)).toBe('codex')
  })
  it('skips an unavailable Claude provider without hiding Superbot', () => {
    expect(nextConversationProvider('codex', false)).toBe('superbot')
    expect(nextConversationProvider('superbot', false)).toBe('codex')
  })
})
