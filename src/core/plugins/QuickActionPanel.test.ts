import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRunStatus } from '../agent-runs/types'
import { quickActionRunsStatus, quickActionRunStatus, runsForQuickAction, shouldShowRunGroup } from './QuickActionPanel'

function run(status: AgentRunStatus, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1', instanceId: 'quick-agent', mode: 'detached', workspaceAccess: 'shared-write', status,
    title: '常用任务', workspaceRoot: '/repo', parentThreadId: null,
    childThreadId: 'thread-1', turnId: 'turn-1', errorSummary: null,
    createdAt: 1, updatedAt: 1, completedAt: null, returnedAt: null,
    ...overrides,
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

  it('keeps a job running while any run is active', () => {
    expect(quickActionRunsStatus([run('completed'), run('running')], false)).toBe('running')
    expect(quickActionRunsStatus([run('completed'), run('failed')], false)).toBe('completed')
  })

  it('groups runs by plugin instance and source conversation', () => {
    const runs = [
      run('running', { runId: 'matching', parentThreadId: 'parent-1' }),
      run('running', { runId: 'other-thread', parentThreadId: 'parent-2' }),
      run('running', { runId: 'other-job', instanceId: 'other', parentThreadId: 'parent-1' }),
    ]
    expect(runsForQuickAction(runs, 'quick-agent', 'parent-1').map((item) => item.runId)).toEqual(['matching'])
    expect(runsForQuickAction(runs, 'quick-agent', null)).toEqual([])
  })

  it('only groups multiple concurrent runs', () => {
    expect(shouldShowRunGroup([run('running')])).toBe(false)
    expect(shouldShowRunGroup([run('running'), run('completed')])).toBe(false)
    expect(shouldShowRunGroup([run('running'), run('waitingApproval')])).toBe(true)
  })
})
