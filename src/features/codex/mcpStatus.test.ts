import { describe, expect, it } from 'vitest'
import { mcpNeedsAttention, mcpStatusLabel, startupRuntimeStatus } from './mcpStatus'

describe('MCP runtime status', () => {
  it('maps startup notifications to inventory connection states', () => {
    expect(startupRuntimeStatus('ready')).toBe('connected')
    expect(startupRuntimeStatus('failed')).toBe('failed')
    expect(startupRuntimeStatus('unknown')).toBeNull()
  })

  it('distinguishes failures from normal transitional states', () => {
    expect(mcpNeedsAttention('failed')).toBe(true)
    expect(mcpNeedsAttention('authenticationRequired')).toBe(true)
    expect(mcpNeedsAttention('starting')).toBe(false)
    expect(mcpNeedsAttention('connected')).toBe(false)
  })

  it('uses user-facing labels for important states', () => {
    expect(mcpStatusLabel('connected')).toBe('已连接')
    expect(mcpStatusLabel('failed')).toBe('启动失败')
    expect(mcpStatusLabel('notStarted')).toBe('未启动')
  })
})
