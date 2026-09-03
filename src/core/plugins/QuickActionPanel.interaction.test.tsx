// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, AgentRunService } from '../agent-runs/types'
import type { QuickActionContribution, QuickActionProps } from '../../extensions/types'
import type { ResolvedContribution } from './runtime'
import { QuickActionPanel } from './QuickActionPanel'

afterEach(cleanup)

describe('QuickActionPanel result return', () => {
  it('manually returns a completed delegated result and marks the run', async () => {
    const service = new FakeAgentRuns([delegatedRun()])
    renderPanel(service)

    fireEvent.click(screen.getByRole('button', { name: '打开快捷 Agent' }))
    fireEvent.click(screen.getByRole('button', { name: /1 条运行记录/ }))
    fireEvent.click(screen.getByRole('button', { name: '回传结果到当前会话' }))

    await waitFor(() => expect(service.returnToParent).toHaveBeenCalledWith('run-1'))
    expect(screen.queryByRole('button', { name: '回传结果到当前会话' })).toBeNull()
    expect(screen.getByText('已回传')).toBeTruthy()
  })

  it('keeps the result available when the parent conversation is still running', async () => {
    const service = new FakeAgentRuns([delegatedRun()])
    service.returnError = new Error('主会话仍在运行，请等待当前任务结束后再回传。')
    renderPanel(service)

    fireEvent.click(screen.getByRole('button', { name: '打开快捷 Agent' }))
    fireEvent.click(screen.getByRole('button', { name: /1 条运行记录/ }))
    fireEvent.click(screen.getByRole('button', { name: '回传结果到当前会话' }))

    expect(await screen.findByText(/主会话仍在运行/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '回传结果到当前会话' })).toBeTruthy()
  })

  it('stops an active run without opening its child conversation', async () => {
    const service = new FakeAgentRuns([delegatedRun({ status: 'running', completedAt: null })])
    renderPanel(service)

    fireEvent.click(screen.getByRole('button', { name: '打开快捷 Agent' }))
    fireEvent.click(screen.getByRole('button', { name: /1 个运行中任务/ }))
    fireEvent.click(screen.getByRole('button', { name: '停止任务' }))

    await waitFor(() => expect(service.cancel).toHaveBeenCalledWith('run-1'))
    expect(screen.getByText('已取消')).toBeTruthy()
  })
})

class FakeAgentRuns implements AgentRunService {
  private listeners = new Set<() => void>()
  private runs: AgentRun[]
  returnError: Error | null = null

  constructor(runs: AgentRun[]) { this.runs = runs }

  initialize = async () => undefined
  snapshot = () => this.runs
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  start = vi.fn()
  cancel = vi.fn(async (runId: string) => {
    this.runs = this.runs.map((run) => run.runId === runId ? { ...run, status: 'cancelled', completedAt: Date.now() } : run)
    for (const listener of this.listeners) listener()
  })
  loadResult = vi.fn()
  buildReturnDraft = vi.fn(async () => '执行结果草稿')
  markReturned = vi.fn(async () => undefined)
  childThreadForFeedback = vi.fn(async () => 'child-1')
  returnToParent = vi.fn(async (runId: string) => {
    if (this.returnError) throw this.returnError
    this.runs = this.runs.map((run) => run.runId === runId ? { ...run, returnedAt: Date.now() } : run)
    for (const listener of this.listeners) listener()
  })
  openWorkspace = vi.fn()
  deliveryContext = vi.fn()
  removeWorkspace = vi.fn()
  openThread = vi.fn()
  handleEvent = vi.fn()
}

function renderPanel(agentRuns: AgentRunService) {
  const actions: ResolvedContribution<QuickActionContribution>[] = [{
    pluginId: 'builtin.quick-agent',
    instanceId: 'quick-agent-1',
    contribution: { id: 'job-1', label: '分析问题', run: vi.fn() },
  }]
  const context: QuickActionProps = {
    threadId: 'parent-1',
    threadCwd: '/repo',
    workspaceRoot: '/repo',
    checkoutRoot: '/repo',
    disabled: false,
  }
  return render(<QuickActionPanel actions={actions} context={context} agentRuns={agentRuns} />)
}

function delegatedRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    instanceId: 'quick-agent-1',
    mode: 'delegated',
    workspaceAccess: 'read-only',
    status: 'completed',
    title: '分析问题',
    workspaceRoot: '/repo',
    parentThreadId: 'parent-1',
    childThreadId: 'child-1',
    turnId: 'turn-1',
    errorSummary: null,
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    returnedAt: null,
    workspaceRemovedAt: null,
    ...overrides,
  }
}
