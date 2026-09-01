import { describe, expect, it } from 'vitest'
import type { Thread } from '../../core/domain/codex'
import { claudeProviderDescription, reorderThreadIds, splitThreadsByProvider } from './Sidebar'

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

describe('sidebar provider split', () => {
  const thread = (id: string, provider?: 'codex' | 'claude'): Thread => ({ id, provider } as Thread)

  it('puts codex and legacy (provider-less) threads first, claude threads second', () => {
    const legacy = thread('legacy')
    const codexA = thread('codex-a', 'codex')
    const claudeA = thread('claude-a', 'claude')
    const codexB = thread('codex-b', 'codex')
    const claudeB = thread('claude-b', 'claude')
    const { codex, claude } = splitThreadsByProvider([legacy, claudeA, codexA, claudeB, codexB])
    expect(codex.map(({ id }) => id)).toEqual(['legacy', 'codex-a', 'codex-b'])
    expect(claude.map(({ id }) => id)).toEqual(['claude-a', 'claude-b'])
  })

  it('tolerates an all-codex or all-claude list', () => {
    const onlyCodex = splitThreadsByProvider([thread('a', 'codex')])
    expect(onlyCodex.codex).toHaveLength(1)
    expect(onlyCodex.claude).toHaveLength(0)
    const onlyClaude = splitThreadsByProvider([thread('b', 'claude')])
    expect(onlyClaude.codex).toHaveLength(0)
    expect(onlyClaude.claude).toHaveLength(1)
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
