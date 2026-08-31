import { describe, expect, it } from 'vitest'
import type { ConversationTabContribution } from '../../extensions/types'
import { conversationTabSupportsFocus } from './tabFocus'

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
