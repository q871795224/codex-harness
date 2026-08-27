import { describe, expect, it } from 'vitest'
import { isExternalWebUrl, titleEditorKeyAction } from './ConversationView'

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
