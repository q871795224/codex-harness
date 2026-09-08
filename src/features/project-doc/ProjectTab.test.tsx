// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import { ProjectTab, PROJECT_STATUS_TEMPLATE } from './ProjectTab'

afterEach(cleanup)
const meta = { projectId: 'demo', name: '示例项目', currentSeq: 2, createdAt: 1, updatedAt: 1 }
function service(content = ''): ProjectDocService {
  return {
    create: vi.fn(async () => meta), list: vi.fn(async () => [meta]), get: vi.fn(async () => meta),
    rename: vi.fn(async () => undefined), archive: vi.fn(async () => undefined),
    read: vi.fn(async () => ({ projectId: 'demo', currentSeq: 2, content, contentHash: 'h', consistent: true })),
    versions: vi.fn(async () => []), workspaces: vi.fn(async () => []), bindWorkspace: vi.fn(),
    writeSection: vi.fn(async () => ({ kind: 'applied' as const, newSeq: 3, contentHash: 'h' })),
    listProposals: vi.fn(async () => []),
    approveProposal: vi.fn(async () => ({ kind: 'applied' as const, newSeq: 3, contentHash: 'h' })),
    rejectProposal: vi.fn(async () => undefined),
    ensureServer: vi.fn(async () => 0),
    threadProject: vi.fn(async () => null), bindThread: vi.fn(), unbindThread: vi.fn(),
    threadBinding: vi.fn(async () => null), lockThreadBinding: vi.fn(async () => undefined),
    subscribeBindings: vi.fn(() => () => undefined),
  }
}
function mount(svc: ProjectDocService, selectedProjectId: string | null = null) {
  render(<ProjectTab service={svc} selectedProjectId={selectedProjectId} conflictRequest={null} onSelectProject={vi.fn()} onConflictHandled={vi.fn()} />)
}

it('does not create on IME confirmation or WebKit 229, and prevents duplicate creation', async () => {
  const svc = service()
  mount(svc)
  const input = screen.getByLabelText('新项目名称')
  fireEvent.change(input, { target: { value: '中文项目' } })
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(svc.create).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(svc.create).toHaveBeenCalledTimes(1))
  expect(svc.create).toHaveBeenCalledWith(expect.stringMatching(/^[a-z0-9-]+$/), '中文项目')
})

it('shows columns and supports rename and confirmed archive', async () => {
  const svc = service()
  mount(svc)
  await screen.findByText('示例项目')
  expect(screen.getAllByRole('columnheader').map((el) => el.textContent)).toEqual(['项目名称', '版本', '更新时间', '操作'])
  fireEvent.click(screen.getByText('重命名'))
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '新名称' } })
  fireEvent.click(screen.getByText('保存名称'))
  await waitFor(() => expect(svc.rename).toHaveBeenCalledWith('demo', '新名称'))
  await screen.findByText('重命名')
  fireEvent.click(screen.getByText('归档'))
  expect(svc.archive).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('确认归档'))
  await waitFor(() => expect(svc.archive).toHaveBeenCalledWith('demo'))
})

it('starts empty status with a template', async () => {
  mount(service(), 'demo')
  await screen.findByText('示例项目')
  fireEvent.click(screen.getByText('编辑'))
  expect((screen.getByLabelText('编辑项目文档') as HTMLTextAreaElement).value).toBe(PROJECT_STATUS_TEMPLATE)
})

it('edits only Status without copying Log or document metadata into it', async () => {
  const svc = service('---\nseq: 2\n---\n## Status\n已有进展\n## Log\n保留日志')
  mount(svc, 'demo')
  await screen.findByText('示例项目')
  fireEvent.click(screen.getByText('编辑'))
  expect((screen.getByLabelText('编辑项目文档') as HTMLTextAreaElement).value).toBe('已有进展')
  fireEvent.click(screen.getByText('保存'))
  await waitFor(() => expect(svc.writeSection).toHaveBeenCalledWith(expect.objectContaining({ section: 'status', content: '已有进展', baseSeq: 2 })))
})
