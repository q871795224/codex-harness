import { describe, expect, it } from 'vitest'
import {
  actionForShortcut,
  conflictingAction,
  defaultHarnessActionShortcuts,
  formatShortcut,
  normalizeHarnessActionShortcuts,
  shortcutFromEvent,
  threadIndexForAction,
} from './harnessActions'

const key = (value: string, overrides = {}) => ({
  key: value, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides,
})

describe('Harness action shortcuts', () => {
  it('matches the iTerm-style defaults', () => {
    expect(actionForShortcut(key('t', { metaKey: true }), defaultHarnessActionShortcuts)).toBe('thread.new')
    expect(actionForShortcut(key('3', { metaKey: true }), defaultHarnessActionShortcuts)).toBe('thread.select.3')
    expect(threadIndexForAction('thread.select.3')).toBe(2)
    expect(actionForShortcut(key('Escape'), defaultHarnessActionShortcuts)).toBe('composer.focus')
  })

  it('records only Escape or modified shortcuts', () => {
    expect(shortcutFromEvent(key('b', { metaKey: true, shiftKey: true }))).toBe('Mod+Shift+B')
    expect(shortcutFromEvent(key('b'))).toBeNull()
    expect(shortcutFromEvent(key('Shift', { shiftKey: true }))).toBeNull()
  })

  it('fills missing saved actions and reports conflicts', () => {
    const shortcuts = normalizeHarnessActionShortcuts({ 'thread.new': 'Mod+N' })
    expect(shortcuts['thread.new']).toBe('Mod+N')
    expect(shortcuts['sidebar.toggle']).toBe('Mod+B')
    expect(conflictingAction(shortcuts, 'thread.new', 'Mod+B')).toBe('sidebar.toggle')
    expect(formatShortcut('Mod+Shift+B')).toBe('⌘⇧B')
  })
})
