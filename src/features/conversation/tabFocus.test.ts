import { describe, expect, it } from 'vitest'
import type { ConversationTabContribution } from '../../extensions/types'
import { conversationComposerState, conversationTabSupportsFocus } from './tabFocus'

const contribution = (focusable?: boolean): ConversationTabContribution => ({
  id: 'tab', label: 'Tab', focusable, render: () => null,
})

describe('conversation Tab focus mode', () => {
  it('enables current and future plugin Tabs by default', () => {
    expect(conversationTabSupportsFocus(contribution())).toBe(true)
    expect(conversationTabSupportsFocus(contribution(true))).toBe(true)
    expect(conversationTabSupportsFocus(contribution(false))).toBe(false)
    expect(conversationTabSupportsFocus(null)).toBe(false)
  })
})

it('shares the composer with built-in async and plugin tabs, preserving collapse and archived behavior', () => {
  expect(conversationComposerState('async-waits', true, null, false)).toEqual({ collapsible: true, visible: true })
  expect(conversationComposerState('async-waits', true, null, true).visible).toBe(false)
  expect(conversationComposerState('async-waits', false, null, false).visible).toBe(false)
  expect(conversationComposerState('plugin', true, { ...contribution(), hideComposer: true }, false).visible).toBe(false)
  expect(conversationComposerState('chat', true, null, true)).toEqual({ collapsible: false, visible: true })
})
