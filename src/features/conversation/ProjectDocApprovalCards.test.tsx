// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDocService, ProjectDocProposal } from '../../core/project-docs/types'
import type { ProjectDocWriteOutcome } from '../project-doc/types'
import { ProjectDocApprovalCards } from './ProjectDocApprovalCards'

afterEach(cleanup)

function proposal(overrides: Partial<ProjectDocProposal> = {}): ProjectDocProposal {
  return {
    id: 'prop-1',
    projectId: 'demo',
    threadId: 'thread-1',
    section: 'status',
    content: '### run-1: 进展\n完成',
    baseSeq: 3,
    createdAt: 1,
    ...overrides,
  }
}

function fakeService(options: {
  proposals?: ProjectDocProposal[]
  currentSeq?: number
  approveOutcome?: ProjectDocWriteOutcome
} = {}): ProjectDocService {
  const proposals = options.proposals ?? []
  const currentSeq = options.currentSeq ?? 3
  const approveOutcome = options.approveOutcome ?? { kind: 'applied', newSeq: 4, contentHash: 'h' }
  return {
    create: vi.fn(), list: vi.fn(), get: vi.fn(), rename: vi.fn(), archive: vi.fn(),
    bindWorkspace: vi.fn(), workspaces: vi.fn(),
    read: vi.fn(async () => ({ projectId: 'demo', currentSeq, content: '', contentHash: 'h', consistent: true })),
    versions: vi.fn(async () => []),
    writeSection: vi.fn(),
    listProposals: vi.fn(async () => proposals),
    approveProposal: vi.fn(async () => approveOutcome),
    rejectProposal: vi.fn(async () => undefined),
    ensureServer: vi.fn(async () => 0),
    threadProject: vi.fn(async () => null),
    threadBinding: vi.fn(async () => null),
    bindThread: vi.fn(), lockThreadBinding: vi.fn(), unbindThread: vi.fn(),
    subscribeBindings: vi.fn(() => () => undefined),
  } as unknown as ProjectDocService
}

describe('ProjectDocApprovalCards（队列驱动）', () => {
  it('无待审批提议时不渲染', async () => {
    const service = fakeService({ proposals: [] })
    const { container } = render(<ProjectDocApprovalCards projectDoc={service} projectId="demo" onOpenProject={vi.fn()} />)
    await waitFor(() => expect(service.listProposals).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('渲染队列里的提议并在确认时 approveProposal', async () => {
    const service = fakeService({ proposals: [proposal()] })
    render(<ProjectDocApprovalCards projectDoc={service} projectId="demo" onOpenProject={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /确认写入/ }))
    await waitFor(() => expect(service.approveProposal).toHaveBeenCalledWith('prop-1'))
    expect(await screen.findByText(/已落盘为 v4/)).toBeTruthy()
  })

  it('CAS 冲突时进冲突态并可查看差异', async () => {
    const service = fakeService({
      proposals: [proposal()],
      approveOutcome: { kind: 'conflict', currentSeq: 5, baseSeq: 3 },
    })
    const onOpenProject = vi.fn()
    render(<ProjectDocApprovalCards projectDoc={service} projectId="demo" onOpenProject={onOpenProject} />)
    fireEvent.click(await screen.findByRole('button', { name: /确认写入/ }))
    expect(await screen.findByText(/版本冲突/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /查看差异/ }))
    expect(onOpenProject).toHaveBeenCalledWith({ conflict: { proposalContent: '### run-1: 进展\n完成', section: 'status' } })
  })

  it('拒绝时 rejectProposal 并隐藏卡片', async () => {
    const service = fakeService({ proposals: [proposal()] })
    render(<ProjectDocApprovalCards projectDoc={service} projectId="demo" onOpenProject={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /拒绝/ }))
    await waitFor(() => expect(service.rejectProposal).toHaveBeenCalledWith('prop-1'))
  })

  it('轮询队列（新的提议会出现）', async () => {
    vi.useFakeTimers()
    try {
      const service = fakeService({ proposals: [] })
      const { unmount } = render(<ProjectDocApprovalCards projectDoc={service} projectId="demo" onOpenProject={vi.fn()} />)
      const calls = () => (service.listProposals as ReturnType<typeof vi.fn>).mock.calls.length
      const before = calls()
      await vi.advanceTimersByTimeAsync(2_100)
      expect(calls()).toBeGreaterThan(before)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
