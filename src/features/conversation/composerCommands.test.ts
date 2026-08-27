import { describe, expect, it } from 'vitest'
import { parseComposerCommand } from './composerCommands'

describe('composer commands', () => {
  it('recognizes /raw with surrounding whitespace', () => {
    expect(parseComposerCommand('  /raw\n', false)).toEqual({ name: 'raw' })
  })

  it('does not consume prompts or commands with arguments', () => {
    expect(parseComposerCommand('explain /raw', false)).toBeNull()
    expect(parseComposerCommand('/raw response', false)).toBeNull()
    expect(parseComposerCommand('/unknown', false)).toBeNull()
  })

  it('does not consume a draft that also has attachments', () => {
    expect(parseComposerCommand('/raw', true)).toBeNull()
  })
})
