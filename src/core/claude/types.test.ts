import { describe, expect, it } from 'vitest'
import { claudeTurnPermissionOptions } from './types'

describe('Claude turn permission options', () => {
  it('enables the SDK safety acknowledgement for bypass mode', () => {
    expect(claudeTurnPermissionOptions({ permissionMode: 'bypassPermissions' })).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    })
  })

  it('does not enable the bypass acknowledgement for regular modes', () => {
    expect(claudeTurnPermissionOptions({ permissionMode: 'default' })).toEqual({
      permissionMode: 'default',
    })
  })
})
