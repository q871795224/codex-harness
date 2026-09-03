import { describe, expect, it } from 'vitest'
import { parseComposerCommand } from './composerCommands'

describe('composer commands', () => {
  it('recognizes /raw with surrounding whitespace', () => {
    expect(parseComposerCommand('  /raw\n', false)).toEqual({ name: 'raw' })
    expect(parseComposerCommand('/new', false)).toEqual({ name: 'new' })
    expect(parseComposerCommand('/reset', false)).toEqual({ name: 'reset' })
    expect(parseComposerCommand('/handover', false)).toEqual({ name: 'handover' })
    expect(parseComposerCommand('/model gpt-5.6-luna', false)).toEqual({ name: 'model', model: 'gpt-5.6-luna' })
    expect(parseComposerCommand('/reasoning high', false)).toEqual({ name: 'reasoning', effort: 'high' })
    expect(parseComposerCommand('/permissions never', false)).toEqual({ name: 'permissions', approvalPolicy: 'never' })
  })

  it('does not consume prompts or commands with arguments', () => {
    expect(parseComposerCommand('explain /raw', false)).toBeNull()
    expect(parseComposerCommand('/raw response', false)).toBeNull()
    expect(parseComposerCommand('/unknown', false)).toBeNull()
    expect(parseComposerCommand('/model', false)).toBeNull()
  })

  it('does not consume a draft that also has attachments', () => {
    expect(parseComposerCommand('/raw', true)).toBeNull()
  })
})
