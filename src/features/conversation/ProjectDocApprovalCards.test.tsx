// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { ProjectDocWriteOutcome, ProjectMeta, ProjectDocSnapshot } from '../project-doc/types'
import { ProjectDocApprovalCards } from './ProjectDocApprovalCards'
import type { ThreadItemEntry } from '../../core/domain/codex'

afterEach(cleanup)

function meta(projectId = 'demo', currentSeq = 3): ProjectMeta {
  return { projectId, name: 'Demo', currentSeq, createdAt: 1, updatedAt: 1 }
}

function snapshot(projectId = 'demo', currentSeq = 3): ProjectDocSnapshot {
  return { projectId, currentSeq, content: '# 文档', contentHash: 'h', consistent: true }
}

function fakeService(outcome: ProjectDocWriteOutcome = { kind: 'applied', newSeq: 4, contentHash: 'h' }): ProjectDocService {
  return {
    create: vi.fn(async () => meta()),
    list: vi.fn(async () => [meta()]),
    get: vi.fn(async () => meta()),
    bindWorkspace: vi.fn(async () => undefined),
    workspaces: vi.fn(async () => []),
    read: vi.fn(async () => snapshot()),
    versions: vi.fn(async () => []),
    writeSection: vi.fn(async () => outcome),
    threadProject: vi.fn(async () => null),
    bindThread: vi.fn(async () => undefined),
    unbindThread: vi.fn(async () => undefined),
  }
}

function itemsWith(text: string): ThreadItemEntry[] {
  return [{ turnId: 't1', item: { type: 'agentMessage', id: 'm1', text, phase: null } }]
}

describe('ProjectDocApprovalCards', () => {
  it('renders nothing without controlled-section proposals', () => {
    const service = fakeService()
    const { container } = render(
      <ProjectDocApprovalCards items={itemsWith('普通回复')} projectDoc={service} projectId="demo" updatedBy="thread-1" onOpenProject={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('skips append-section proposals (一期只受控区过卡)', () => {
    const service = fakeService()
    const { container } = render(
      <ProjectDocApprovalCards
        items={itemsWith('<project-doc-update>\nsection: log\n\n进展一条\n</project-doc-update>')}
        projectDoc={service}
        projectId="demo"
        updatedBy="thread-1"
        onOpenProject={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('applies write on confirm', async () => {
    const service = fakeService()
    render(
      <ProjectDocApprovalCards
        items={itemsWith('<project-doc-update>\nsection: status\nbase_seq: 3\n\n### run-1: 进展\n完成\n</project-doc-update>')}
        projectDoc={service}
        projectId="demo"
        updatedBy="thread-1"
        onOpenProject={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /确认写入/ }))
    await waitFor(() => expect(service.writeSection).toHaveBeenCalledWith({
      projectId: 'demo',
      section: 'status',
      baseSeq: 3,
      content: '### run-1: 进展\n完成',
      updatedBy: 'thread-1',
      summary: expect.any(String),
    }))
    expect(await screen.findByText(/已落盘为 v4/)).toBeTruthy()
  })

  it('enters conflict state when CAS fails and opens project tab on 查看差异', async () => {
    const service = fakeService({ kind: 'conflict', currentSeq: 5, baseSeq: 3 })
    const onOpenProject = vi.fn()
    render(
      <ProjectDocApprovalCards
        items={itemsWith('<project-doc-update>\nsection: status\nbase_seq: 3\n\n内容\n</project-doc-update>')}
        projectDoc={service}
        projectId="demo"
        updatedBy="thread-1"
        onOpenProject={onOpenProject}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /确认写入/ }))
    expect(await screen.findByText(/版本冲突/)).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: /查看差异/ }))
    expect(onOpenProject).toHaveBeenCalledWith({ conflict: { proposalContent: '内容', section: 'status' } })
  })

  it('rejects without writing', async () => {
    const service = fakeService()
    render(
      <ProjectDocApprovalCards
        items={itemsWith('<project-doc-update>\nsection: status\nbase_seq: 3\n\n内容\n</project-doc-update>')}
        projectDoc={service}
        projectId="demo"
        updatedBy="thread-1"
        onOpenProject={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /拒绝/ }))
    await waitFor(() => expect(screen.findByText(/已放弃这次写入/)).toBeTruthy())
    expect(service.writeSection).not.toHaveBeenCalled()
  })
})
