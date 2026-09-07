// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuickCommandContribution } from '../../extensions/types'
import type { ResolvedContribution } from './runtime'
import { QuickCommandPanel } from './QuickCommandPanel'

afterEach(cleanup)

function makeCommand(): ResolvedContribution<QuickCommandContribution>[] {
  return [{
    pluginId: 'builtin.test',
    instanceId: 'test-1',
    contribution: { id: 'cmd-1', label: '测试命令', command: 'echo hi', run: vi.fn(async () => ({ success: true, message: 'ok' })) },
  }]
}

describe('QuickCommandPanel 简化箭头', () => {
  it('trigger 上没有箭头图标，只有 Terminal icon', () => {
    render(<QuickCommandPanel commands={makeCommand()} />)
    const trigger = screen.getByRole('button', { name: '打开快捷命令' })

    // trigger 里不应该有 ChevronUp（通过 svg 数量判断：只有 1 个 Terminal icon）
    const svgs = trigger.querySelectorAll('svg')
    expect(svgs.length).toBe(1)
  })

  it('展开后点击 header 标题区域收起面板', () => {
    render(<QuickCommandPanel commands={makeCommand()} />)

    // 展开
    fireEvent.click(screen.getByRole('button', { name: '打开快捷命令' }))
    expect(screen.getByText('快捷命令')).toBeTruthy()

    // 不应该有单独的「收起快捷命令」按钮
    expect(screen.queryByRole('button', { name: '收起快捷命令' })).toBeNull()

    // 点击 header 标题区域（icon + 文字）收起
    const header = screen.getByText('快捷命令').closest('header')!
    fireEvent.click(header.querySelector('.quick-panel-header-title')!)

    // 应该收起了
    expect(screen.queryByText('快捷命令')).toBeNull()
    expect(screen.getByRole('button', { name: '打开快捷命令' })).toBeTruthy()
  })
})
