// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import { ProjectBindingPanel } from './ProjectBindingPanel'

afterEach(cleanup)

function makeService(): ProjectDocService {
  return {
    create: vi.fn(),
    list: vi.fn(async () => [{ projectId: 'p1', name: '示例项目', currentSeq: 1, createdAt: 1, updatedAt: 1 }]),
    get: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
    bindWorkspace: vi.fn(),
    workspaces: vi.fn(async () => []),
    read: vi.fn(),
    versions: vi.fn(async () => []),
    writeSection: vi.fn(),
    writeDocument: vi.fn(),
    threadProject: vi.fn(async () => null),
    threadBinding: vi.fn(async () => null),
    bindThread: vi.fn(),
    lockThreadBinding: vi.fn(),
    unbindThread: vi.fn(),
    subscribeBindings: vi.fn(() => () => undefined),
  } as unknown as ProjectDocService
}

describe('ProjectBindingPanel 单行布局', () => {
  it('未绑定时不渲染描述文案和 hint，下拉框 placeholder 为「绑定项目（可选）…」', async () => {
    const service = makeService()
    render(<ProjectBindingPanel service={service} threadId="t1" workspaceRoot={null} onOpenProject={() => undefined} />)

    // 不应该有描述性文案
    expect(screen.queryByText(/绑定项目文档后/)).toBeNull()
    expect(screen.queryByText(/绑定项目后，首页输入框会带上项目背景/)).toBeNull()

    // 不应该有 hint
    expect(screen.queryByText(/第 0 轮可改/)).toBeNull()
    expect(screen.queryByText(/不绑定则首页不注入背景/)).toBeNull()
    expect(screen.queryByText(/绑定按会话记忆/)).toBeNull()

    // 下拉框 placeholder
    const select = await screen.findByLabelText('绑定项目')
    const placeholder = select.querySelector('option[value=""]')
    expect(placeholder?.textContent).toBe('绑定项目（可选）…')
  })
})
