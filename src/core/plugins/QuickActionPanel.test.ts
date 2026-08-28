import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRunStatus } from '../agent-runs/types'
import { quickActionRunStatus } from './QuickActionPanel'

function run(status: AgentRunStatus): AgentRun {
  return {
    runId: 'run-1', instanceId: 'quick-agent', mode: 'detached', status,
    title: '常用任务', workspaceRoot: '/repo', parentThreadId: null,
    childThreadId: 'thread-1', turnId: 'turn-1', errorSummary: null,
    createdAt: 1, updatedAt: 1, completedAt: null, returnedAt: null,
  }
}

describe('quickActionRunStatus', () => {
  it('keeps all active phases spinning', () => {
    expect(quickActionRunStatus(run('starting'), false)).toBe('running')
    expect(quickActionRunStatus(run('waitingApproval'), false)).toBe('running')
  })

  it('retains terminal success and failure feedback', () => {
    expect(quickActionRunStatus(run('completed'), false)).toBe('completed')
    expect(quickActionRunStatus(run('failed'), false)).toBe('failed')
    expect(quickActionRunStatus(run('cancelled'), false)).toBe('failed')
  })
})
