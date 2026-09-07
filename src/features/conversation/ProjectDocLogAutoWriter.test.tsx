// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { ProjectDocWriteOutcome, ProjectDocSnapshot, ProjectMeta } from '../project-doc/types'
import { ProjectDocLogAutoWriter } from './ProjectDocLogAutoWriter'
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

describe('ProjectDocLogAutoWriter', () => {
  it('auto-writes append proposals without approval (免审批直落盘)', async () => {
    const service = fakeService()
    render(
      <ProjectDocLogAutoWriter
        items={itemsWith('<project-doc-update>\nsection: log\n\n进展一条\n</project-doc-update>')}
        projectDoc={service}
        projectId="demo"
        updatedBy="thread-1"
      />,
    )
    await waitFor(() => expect(service.writeSection).toHaveBeenCalledWith({
      projectId: 'demo',
      section: 'log',
      content: '进展一条',
      updatedBy: 'thread-1',
      summary: expect.any(String),
    }))
    // 免审批：不带 baseSeq
    expect((service.writeSection as ReturnType<typeof vi.fn>).mock.calls[0][0].baseSeq).toBeUndefined()
    expect(await screen.findByText(/已追加到 Log · v4/)).toBeTruthy()
  })

  it('writes once per proposal even when items re-render (dedupe)', async () => {
    const service = fakeService()
    const items = itemsWith('<project-doc-update>\nsection: log\n\n进展\n</project-doc-update>')
    const { rerender } = render(
      <ProjectDocLogAutoWriter items={items} projectDoc={service} projectId="demo" updatedBy="thread-1" />,
    )
    await waitFor(() => expect(service.writeSection).toHaveBeenCalledTimes(1))
    rerender(<ProjectDocLogAutoWriter items={[...items]} projectDoc={service} projectId="demo" updatedBy="thread-1" />)
    await waitFor(() => expect(screen.findByText(/已追加到 Log/)).toBeTruthy())
    expect(service.writeSection).toHaveBeenCalledTimes(1)
  })

  it('shows error state and retries on failure (失败不静默)', async () => {
    let attempt = 0
    const service = fakeService()
    ;(service.writeSection as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('磁盘写失败')
      return { kind: 'applied', newSeq: 4, contentHash: 'h' } satisfies ProjectDocWriteOutcome
    })
    render(
      <ProjectDocLogAutoWriter
        items={itemsWith('<project-doc-update>\nsection: log\n\n进展\n</project-doc-update>')}
        projectDoc={service}
        projectId="demo"
        updatedBy="thread-1"
      />,
    )
    expect(await screen.findByText(/追加失败：磁盘写失败/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    await waitFor(() => expect(screen.findByText(/已追加到 Log · v4/)).toBeTruthy())
    expect(service.writeSection).toHaveBeenCalledTimes(2)
  })

  it('ignores controlled-section proposals (审批卡那边管)', async () => {
    const service = fakeService()
    const { container } = render(
      <ProjectDocLogAutoWriter
        items={itemsWith('<project-doc-update>\nsection: status\nbase_seq: 3\n\n内容\n</project-doc-update>')}
        projectDoc={service}
        projectId="demo"
        updatedBy="thread-1"
      />,
    )
    await waitFor(() => expect(container.firstChild).toBeNull())
    expect(service.writeSection).not.toHaveBeenCalled()
  })
})
