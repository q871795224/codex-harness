// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunService } from '../agent-runs/types'
import type { QuickActionContribution, QuickActionProps } from '../../extensions/types'
import type { ResolvedContribution } from './runtime'
import { QuickActionPanel } from './QuickActionPanel'

afterEach(cleanup)

class FakeAgentRuns {
  private listeners = new Set<() => void>()
  private runs: never[] = []
  initialize = async () => undefined
  snapshot = () => this.runs
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  start = vi.fn()
  cancel = vi.fn()
  loadResult = vi.fn()
  buildReturnDraft = vi.fn()
  markReturned = vi.fn()
  childThreadForFeedback = vi.fn()
  returnToParent = vi.fn()
  openWorkspace = vi.fn()
  deliveryContext = vi.fn()
  removeWorkspace = vi.fn()
  openThread = vi.fn()
  handleEvent = vi.fn()
}

function renderPanel() {
  const actions: ResolvedContribution<QuickActionContribution>[] = [{
    pluginId: 'builtin.quick-agent',
    instanceId: 'qa-1',
    contribution: { id: 'job-1', label: '分析问题', run: vi.fn() },
  }]
  const context: QuickActionProps = {
    threadId: 't1',
    threadCwd: '/repo',
    workspaceRoot: '/repo',
    checkoutRoot: '/repo',
    disabled: false,
  }
  return render(<QuickActionPanel actions={actions} context={context} agentRuns={new FakeAgentRuns() as unknown as AgentRunService} />)
}

describe('QuickActionPanel 简化箭头', () => {
  it('trigger 上没有箭头图标，只有 Bot icon', () => {
    renderPanel()
    const trigger = screen.getByRole('button', { name: '打开快捷 Agent' })

    // trigger 里不应该有 ChevronDown（只有 1 个 Bot icon）
    const svgs = trigger.querySelectorAll('svg')
    expect(svgs.length).toBe(1)
  })

  it('展开后点击 header 标题区域收起面板', () => {
    renderPanel()

    // 展开
    fireEvent.click(screen.getByRole('button', { name: '打开快捷 Agent' }))
    expect(screen.getByText('快捷 Agent')).toBeTruthy()

    // 不应该有单独的「收起快捷 Agent」按钮
    expect(screen.queryByRole('button', { name: '收起快捷 Agent' })).toBeNull()

    // 点击 header 标题区域收起
    const header = screen.getByText('快捷 Agent').closest('header')!
    fireEvent.click(header.querySelector('.quick-panel-header-title')!)

    // 应该收起了
    expect(screen.queryByText('快捷 Agent')).toBeNull()
    expect(screen.getByRole('button', { name: '打开快捷 Agent' })).toBeTruthy()
  })
})
