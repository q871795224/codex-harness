import { describe, expect, it } from 'vitest'
import { claudeProviderDescription, reorderThreadIds } from './Sidebar'

describe('sidebar manual ordering', () => {
  it('places a dragged thread on the requested side of its target', () => {
    expect(reorderThreadIds(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(reorderThreadIds(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c'])
  })

  it('leaves the order unchanged for an invalid drag', () => {
    const ids = ['a', 'b']
    expect(reorderThreadIds(ids, 'missing', 'a', 'before')).toBe(ids)
    expect(reorderThreadIds(ids, 'a', 'a', 'after')).toBe(ids)
  })
})

describe('Claude Provider status copy', () => {
  it('distinguishes managed connections from fallback startup', () => {
    const base = {
      available: true,
      nodePath: '/node',
      claudePath: '/claude',
      daemonPath: '/daemon.mjs',
      socketPath: '/provider.sock',
      error: null,
    }
    expect(claudeProviderDescription({ ...base, managed: true, running: true })).toBe('AIS Switch · Provider 已连接')
    expect(claudeProviderDescription({ ...base, managed: false, running: true })).toBe('AIS Switch · Provider 已连接（按需）')
    expect(claudeProviderDescription({ ...base, managed: true, running: false })).toBe('AIS Switch · Provider 启动中')
  })
})
