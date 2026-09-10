// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import { ProjectTab } from './ProjectTab'
import { RetainedTab } from '../conversation/RetainedTab'

afterEach(cleanup)
const meta = { projectId: 'demo', name: '示例项目', currentSeq: 2, createdAt: 1, updatedAt: 1 }
function service(content = ''): ProjectDocService {
  return {
    create: vi.fn(async () => meta), list: vi.fn(async () => [meta]), get: vi.fn(async () => meta),
    rename: vi.fn(async () => undefined), archive: vi.fn(async () => undefined),
    read: vi.fn(async () => ({ projectId: 'demo', currentSeq: 2, content, contentHash: 'h', consistent: true })),
    versions: vi.fn(async () => []), workspaces: vi.fn(async () => []), bindWorkspace: vi.fn(),
    writeSection: vi.fn(async () => ({ kind: 'applied' as const, newSeq: 3, contentHash: 'h' })),
    writeDocument: vi.fn(async () => ({ kind: 'applied' as const, newSeq: 3, contentHash: 'h' })),
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

it('retains the project editor and unsaved content across tab switches', async () => {
  const svc = service('## Status\n已有进展')
  const view = (active: boolean) => <RetainedTab active={active}><ProjectTab service={svc} selectedProjectId="demo" conflictRequest={null} onSelectProject={vi.fn()} onConflictHandled={vi.fn()} /></RetainedTab>
  const { rerender } = render(view(true))
  await screen.findByText('示例项目')
  fireEvent.click(screen.getByText('编辑'))
  const editor = screen.getByLabelText('编辑整篇项目文档') as HTMLTextAreaElement
  fireEvent.change(editor, { target: { value: '未保存的编辑内容' } })
  rerender(view(false))
  rerender(view(true))
  expect(screen.getByLabelText('编辑整篇项目文档')).toBe(editor)
  expect(editor.value).toBe('未保存的编辑内容')
  expect(svc.writeSection).not.toHaveBeenCalled()
})

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

it('edits the full document including all sections via 编辑', async () => {
  const full = '## Status\n已有进展\n## Log\n保留日志'
  const svc = service(full)
  mount(svc, 'demo')
  await screen.findByText('示例项目')
  fireEvent.click(screen.getByText('编辑'))
  const textarea = screen.getByLabelText('编辑整篇项目文档') as HTMLTextAreaElement
  // 整文（含所有分区），不带 front matter。
  expect(textarea.value).toBe(full)
  expect(screen.getAllByRole('button', { name: /^编辑$/ })).toHaveLength(1)
  fireEvent.change(textarea, { target: { value: '## Status\n全新正文\n## Log\n新日志' } })
  fireEvent.click(screen.getByText('保存'))
  await waitFor(() => expect(svc.writeDocument).toHaveBeenCalledWith(expect.objectContaining({
    projectId: 'demo',
    content: '## Status\n全新正文\n## Log\n新日志',
    baseSeq: 2,
    updatedBy: 'user',
  })))
  expect(svc.writeSection).not.toHaveBeenCalled()
})

it('shows conflict when full-document write returns conflict', async () => {
  const svc = service('## Status\nx')
  ;(svc.writeDocument as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'conflict', currentSeq: 9, baseSeq: 2 })
  mount(svc, 'demo')
  await screen.findByText('示例项目')
  fireEvent.click(screen.getByText('编辑'))
  fireEvent.click(screen.getByText('保存'))
  await screen.findByText(/版本冲突：当前已是 v9/)
})
