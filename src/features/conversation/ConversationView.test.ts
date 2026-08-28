import { describe, expect, it } from 'vitest'
import { CHOOSE_WORKSPACE_VALUE, isChooseWorkspaceSelection, isExternalWebUrl, titleEditorKeyAction } from './ConversationView'
import { resolveNewThreadWorkspaceRoot, shouldDiscardDraftThread } from './useHarness'

describe('titleEditorKeyAction', () => {
  it('does not finish editing while an IME composition is active', () => {
    expect(titleEditorKeyAction('Enter', true)).toBeNull()
    expect(titleEditorKeyAction('Escape', true)).toBeNull()
  })

  it('supports the legacy IME keyCode fallback', () => {
    expect(titleEditorKeyAction('Enter', false, 229)).toBeNull()
  })

  it('saves or cancels outside IME composition', () => {
    expect(titleEditorKeyAction('Enter', false)).toBe('save')
    expect(titleEditorKeyAction('Escape', false)).toBe('cancel')
  })
})

describe('markdown links', () => {
  it('only delegates web URLs to the system browser', () => {
    expect(isExternalWebUrl('https://openai.com/docs')).toBe(true)
    expect(isExternalWebUrl('http://localhost:1420')).toBe(true)
    expect(isExternalWebUrl('/workspace/readme.md')).toBe(false)
    expect(isExternalWebUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('new thread workspace', () => {
  it('routes only the directory option to the native picker', () => {
    expect(isChooseWorkspaceSelection(CHOOSE_WORKSPACE_VALUE)).toBe(true)
    expect(isChooseWorkspaceSelection('/repo/current')).toBe(false)
  })

  it('inherits the workspace of the open thread', () => {
    expect(resolveNewThreadWorkspaceRoot('thread-1', { 'thread-1': '/repo/current' }, '/repo/sidebar')).toBe('/repo/current')
  })

  it('falls back to the selected workspace without an open thread mapping', () => {
    expect(resolveNewThreadWorkspaceRoot('thread-1', {}, '/repo/sidebar')).toBe('/repo/sidebar')
    expect(resolveNewThreadWorkspaceRoot(null, {}, '/repo/sidebar')).toBe('/repo/sidebar')
  })
})

describe('new thread draft lifecycle', () => {
  it('keeps an unstarted thread when its composer has content', () => {
    expect(shouldDiscardDraftThread(true, true)).toBe(false)
  })

  it('discards only an unstarted thread with an empty composer', () => {
    expect(shouldDiscardDraftThread(true, false)).toBe(true)
    expect(shouldDiscardDraftThread(false, false)).toBe(false)
  })
})
