import { describe, expect, it } from 'vitest'
import { quickCommandDefinition, readQuickCommandId } from './config'

describe('quick command config', () => {
  it('reads supported commands and falls back safely', () => {
    expect(readQuickCommandId({ commandId: 'smc-login-test' })).toBe('smc-login-test')
    expect(readQuickCommandId({ commandId: 'rm-everything' })).toBe('vpn-on')
  })

  it('uses the expected command text', () => {
    expect(quickCommandDefinition('smc-login-test').command).toBe('smc login --test')
  })
})
