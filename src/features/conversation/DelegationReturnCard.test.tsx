// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, AgentRunService } from '../../core/agent-runs/types'
import { DelegationReturnCard } from './DelegationReturnCard'

afterEach(cleanup)

function delegatedRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    instanceId: 'job-1',
    mode: 'delegated',
    workspaceAccess: 'read-only',
    status: 'completed',
    title: '实施登录页',
    workspaceRoot: '/repo',
    parentThreadId: 'parent-1',
    childThreadId: 'child-1',
    turnId: 'turn-1',
    errorSummary: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: 2,
    returnedAt: null,
    workspaceRemovedAt: null,
    ...overrides,
  }
}

function fakeService(run: AgentRun): AgentRunService {
  return {
    initialize: async () => undefined,
    snapshot: () => [run],
    subscribe: () => () => undefined,
    start: vi.fn(),
    cancel: vi.fn(),
    loadResult: vi.fn(async () => '结果正文'),
    buildReturnDraft: vi.fn(async () => `以下是临时子 Agent「${run.title}」的执行结果：\n\n结果正文`),
    markReturned: vi.fn(async () => undefined),
    childThreadForFeedback: vi.fn(async () => 'child-1'),
    returnToParent: vi.fn(),
    openWorkspace: vi.fn(),
    deliveryContext: vi.fn(),
    removeWorkspace: vi.fn(),
    openThread: vi.fn(),
    handleEvent: vi.fn(),
  }
}

describe('DelegationReturnCard', () => {
  it('renders nothing when no pending delegated run', () => {
    const run = delegatedRun({ returnedAt: 3 })
    const { container } = render(<DelegationReturnCard runs={[run]} agentRuns={fakeService(run)} onInjectDraft={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('injects result into parent draft and marks returned', async () => {
    const run = delegatedRun()
    const service = fakeService(run)
    const onInjectDraft = vi.fn()
    render(<DelegationReturnCard runs={[run]} agentRuns={service} onInjectDraft={onInjectDraft} />)

    fireEvent.click(screen.getByRole('button', { name: /注入/ }))
    await waitFor(() => expect(onInjectDraft).toHaveBeenCalledWith('parent-1', expect.stringContaining('结果正文')))
    expect(service.markReturned).toHaveBeenCalledWith('run-1')
    // 进入等待验收态，出现回传意见输入框
    expect(await screen.findByLabelText('回传意见')).toBeTruthy()
  })

  it('sends review feedback into the child thread draft', async () => {
    const run = delegatedRun()
    const service = fakeService(run)
    const onInjectDraft = vi.fn()
    render(<DelegationReturnCard runs={[run]} agentRuns={service} onInjectDraft={onInjectDraft} />)

    fireEvent.click(screen.getByRole('button', { name: /注入/ }))
    const input = await screen.findByLabelText('回传意见')
    fireEvent.change(input, { target: { value: '请把按钮换成主色' } })
    fireEvent.click(screen.getByRole('button', { name: /回传/ }))

    await waitFor(() => expect(onInjectDraft).toHaveBeenCalledWith('child-1', expect.stringContaining('请把按钮换成主色')))
  })

  it('dismisses without injecting', async () => {
    const run = delegatedRun()
    const service = fakeService(run)
    const onInjectDraft = vi.fn()
    const { container } = render(<DelegationReturnCard runs={[run]} agentRuns={service} onInjectDraft={onInjectDraft} />)

    fireEvent.click(screen.getByRole('button', { name: /忽略/ }))
    await waitFor(() => expect(service.markReturned).toHaveBeenCalledWith('run-1'))
    expect(onInjectDraft).not.toHaveBeenCalled()
    expect(container.firstChild).toBeNull()
  })
})
