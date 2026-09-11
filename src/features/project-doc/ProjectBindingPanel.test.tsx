// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    bindWorkspace: vi.fn(async () => undefined),
    workspaces: vi.fn(async () => []),
    read: vi.fn(),
    versions: vi.fn(async () => []),
    writeSection: vi.fn(),
    writeDocument: vi.fn(),
    listProposals: vi.fn(async () => []),
    approveProposal: vi.fn(async () => ({ kind: 'applied' as const, newSeq: 3, contentHash: 'h' })),
    rejectProposal: vi.fn(async () => undefined),
    ensureServer: vi.fn(async () => 0),
    threadProject: vi.fn(async () => null),
    threadBinding: vi.fn(async () => null),
    bindThread: vi.fn(),
    lockThreadBinding: vi.fn(),
    unbindThread: vi.fn(),
    subscribeBindings: vi.fn(() => () => undefined),
  } as unknown as ProjectDocService
}

describe('ProjectBindingPanel 单行布局', () => {
  it('未绑定时不渲染描述文案和 hint，下拉框 placeholder 为「绑定项目」', async () => {
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
    expect(placeholder?.textContent).toBe('绑定项目')
  })
  it('keeps binding and clearing available from the inline selector', async () => {
    const service = makeService()
    render(<ProjectBindingPanel service={service} threadId="t1" workspaceRoot="/repo" onOpenProject={() => undefined} />)
    fireEvent.change(await screen.findByLabelText('绑定项目'), { target: { value: 'p1' } })
    await waitFor(() => expect(service.bindThread).toHaveBeenCalledWith('t1', 'p1'))
    await waitFor(() => expect(service.bindWorkspace).toHaveBeenCalledWith('p1', '/repo'))
    fireEvent.change(await screen.findByLabelText('绑定项目'), { target: { value: '' } })
    await waitFor(() => expect(service.unbindThread).toHaveBeenCalledWith('t1'))
  })

  it('auto-selects the first bound workspace when binding a project with existing workspaces', async () => {
    const service = makeService()
    ;(service.workspaces as ReturnType<typeof vi.fn>).mockResolvedValue(['/repo/alpha', '/repo/beta'])
    const onAutoSelect = vi.fn()
    render(<ProjectBindingPanel service={service} threadId="t1" workspaceRoot="/repo" onOpenProject={() => undefined} onAutoSelectWorkspace={onAutoSelect} />)
    fireEvent.change(await screen.findByLabelText('绑定项目'), { target: { value: 'p1' } })
    await waitFor(() => expect(service.bindThread).toHaveBeenCalledWith('t1', 'p1'))
    await waitFor(() => expect(onAutoSelect).toHaveBeenCalledWith('/repo/alpha'))
  })

  it('does not auto-select when the project has no bound workspaces or matches the current workspace', async () => {
    const service = makeService()
    ;(service.workspaces as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const onAutoSelect = vi.fn()
    render(<ProjectBindingPanel service={service} threadId="t1" workspaceRoot="/repo" onOpenProject={() => undefined} onAutoSelectWorkspace={onAutoSelect} />)
    fireEvent.change(await screen.findByLabelText('绑定项目'), { target: { value: 'p1' } })
    await waitFor(() => expect(service.bindThread).toHaveBeenCalledWith('t1', 'p1'))
    // 等待 tick 后仍不应触发
    await waitFor(() => expect(service.bindWorkspace).toHaveBeenCalledWith('p1', '/repo'))
    expect(onAutoSelect).not.toHaveBeenCalled()
  })

  it('does not auto-select when suggested workspace equals the current one', async () => {
    const service = makeService()
    ;(service.workspaces as ReturnType<typeof vi.fn>).mockResolvedValue(['/repo'])
    const onAutoSelect = vi.fn()
    render(<ProjectBindingPanel service={service} threadId="t1" workspaceRoot="/repo" onOpenProject={() => undefined} onAutoSelectWorkspace={onAutoSelect} />)
    fireEvent.change(await screen.findByLabelText('绑定项目'), { target: { value: 'p1' } })
    await waitFor(() => expect(service.bindThread).toHaveBeenCalledWith('t1', 'p1'))
    await waitFor(() => expect(service.bindWorkspace).toHaveBeenCalledWith('p1', '/repo'))
    expect(onAutoSelect).not.toHaveBeenCalled()
  })

})
