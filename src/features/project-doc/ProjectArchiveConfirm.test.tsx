// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import { ProjectTab } from './ProjectTab'

afterEach(cleanup)

const meta = { projectId: 'demo', name: '示例项目', currentSeq: 2, createdAt: 1, updatedAt: 1 }

const CURRENT_DOC = [
  '---',
  'doc_id: demo',
  'seq: 2',
  '---',
  '',
  '## Status',
  '旧的目标',
  '已完成 A',
  '',
  '## Log',
  '历史条目',
].join('\n')

function service(overrides: Partial<ProjectDocService> = {}, content = CURRENT_DOC, seq = 2): ProjectDocService {
  return {
    create: vi.fn(async () => meta), list: vi.fn(async () => [meta]), get: vi.fn(async () => ({ ...meta, currentSeq: seq })),
    rename: vi.fn(async () => undefined), archive: vi.fn(async () => undefined),
    read: vi.fn(async () => ({ projectId: 'demo', currentSeq: seq, content, contentHash: 'h', consistent: true })),
    versions: vi.fn(async () => []), workspaces: vi.fn(async () => []), bindWorkspace: vi.fn(),
    writeSection: vi.fn(async () => ({ kind: 'applied' as const, newSeq: seq + 1, contentHash: 'h' })),
    writeDocument: vi.fn(async () => ({ kind: 'applied' as const, newSeq: seq + 1, contentHash: 'h' })),
    listProposals: vi.fn(async () => []),
    approveProposal: vi.fn(async () => ({ kind: 'applied' as const, newSeq: 3, contentHash: 'h' })),
    rejectProposal: vi.fn(async () => undefined),
    ensureServer: vi.fn(async () => 0),
    threadProject: vi.fn(async () => null), bindThread: vi.fn(), unbindThread: vi.fn(),
    threadBinding: vi.fn(async () => null), lockThreadBinding: vi.fn(async () => undefined),
    subscribeBindings: vi.fn(() => () => undefined),
    ...overrides,
  }
}

const archiveRequest = {
  statusDraft: '旧的目标\n已完成 A\n已完成 B（本次归档新增）',
  baseStatus: '旧的目标\n已完成 A',
  baseSeq: 2,
}

function mountArchive(svc: ProjectDocService) {
  const onArchiveHandled = vi.fn()
  render(
    <ProjectTab
      service={svc}
      selectedProjectId="demo"
      conflictRequest={null}
      archiveRequest={archiveRequest}
      onSelectProject={vi.fn()}
      onConflictHandled={vi.fn()}
      onArchiveHandled={onArchiveHandled}
    />,
  )
  return { onArchiveHandled }
}

it('enters archive view, renders diff with additions highlighted, and saves draft as Status', async () => {
  const svc = service()
  const { onArchiveHandled } = mountArchive(svc)

  // 进入归档确认视图，显示 diff
  await screen.findByText(/归档确认/)
  // 新增行（绿色）应出现在 diff 右侧
  expect(screen.getByText('已完成 B（本次归档新增）')).toBeTruthy()

  // 保存
  fireEvent.click(screen.getByRole('button', { name: /保存到项目文档/ }))
  await waitFor(() => expect(svc.writeSection).toHaveBeenCalled())
  expect(svc.writeSection).toHaveBeenCalledWith(expect.objectContaining({
    projectId: 'demo',
    section: 'status',
    baseSeq: 2,
    content: archiveRequest.statusDraft,
    updatedBy: 'user',
  }))
  await waitFor(() => expect(onArchiveHandled).toHaveBeenCalled())
})

it('lets the user edit the draft before saving', async () => {
  const svc = service()
  mountArchive(svc)
  const textarea = await screen.findByLabelText('编辑归档后的 Status')
  fireEvent.change(textarea, { target: { value: '人改过的内容' } })
  fireEvent.click(screen.getByRole('button', { name: /保存到项目文档/ }))
  await waitFor(() => expect(svc.writeSection).toHaveBeenCalledWith(expect.objectContaining({
    content: '人改过的内容',
  })))
})

it('warns on seq drift (doc updated after draft produced)', async () => {
  // 产出基于 seq 2，但当前已是 seq 5
  const svc = service({}, CURRENT_DOC, 5)
  mountArchive(svc)
  await screen.findByText(/归档产出后文档已被更新/)
})

it('shows conflict when writeSection returns conflict', async () => {
  const svc = service({
    writeSection: vi.fn(async () => ({ kind: 'conflict' as const, currentSeq: 7, baseSeq: 2 })),
    listProposals: vi.fn(async () => []),
    approveProposal: vi.fn(async () => ({ kind: 'applied' as const, newSeq: 3, contentHash: 'h' })),
    rejectProposal: vi.fn(async () => undefined),
    ensureServer: vi.fn(async () => 0),
  })
  mountArchive(svc)
  fireEvent.click(await screen.findByRole('button', { name: /保存到项目文档/ }))
  await screen.findByText(/版本冲突：当前已是 v7/)
})
