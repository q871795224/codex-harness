// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { ProjectEntry, ProjectDocSnapshot } from './types'
import { ProjectEntries } from './ProjectEntries'

afterEach(cleanup)
const entry: ProjectEntry = { id: 'D-test', section: 'decisions', state: 'active', revision: 3, reason: '原规则', replacedBy: null, previousState: null, updatedBy: 't', updatedAt: 1, content: '全量同步' }
const snapshot: ProjectDocSnapshot = { projectId: 'p', currentSeq: 10, content: '', contentHash: '', consistent: true, entries: [entry] }
function setup() {
  const mutateEntry = vi.fn(async () => ({ kind: 'applied', newSeq: 11, contentHash: 'h' }))
  const service = { mutateEntry, writeSection: vi.fn() } as unknown as ProjectDocService
  const changed = vi.fn()
  render(<ProjectEntries service={service} projectId="p" snapshot={snapshot} onChanged={changed} />)
  fireEvent.click(screen.getByRole('button', { name: '维护 D-test' }))
  return { mutateEntry, changed }
}
it('requires a reason for soft delete and submits identity and revision without deleting the body', async () => {
  const { mutateEntry, changed } = setup()
  fireEvent.change(screen.getByLabelText('条目操作'), { target: { value: 'delete' } })
  fireEvent.click(screen.getByRole('button', { name: '保存条目' }))
  expect(mutateEntry).not.toHaveBeenCalled()
  expect(screen.getByText('全量同步')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('条目原因'), { target: { value: '试验失败，保留教训' } })
  fireEvent.click(screen.getByRole('button', { name: '保存条目' }))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(mutateEntry).toHaveBeenCalledWith('p', { action: 'delete', id: 'D-test', revision: 3, reason: '试验失败，保留教训' })
})
it('superseding submits the new decision and a reason as one operation', async () => {
  const { mutateEntry } = setup()
  fireEvent.change(screen.getByLabelText('条目操作'), { target: { value: 'supersede' } })
  expect((screen.getByLabelText('条目正文') as HTMLTextAreaElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('条目正文'), { target: { value: '只补缺失项' } })
  fireEvent.change(screen.getByLabelText('条目原因'), { target: { value: '用户确认新范围' } })
  fireEvent.click(screen.getByRole('button', { name: '保存条目' }))
  await waitFor(() => expect(mutateEntry).toHaveBeenCalledWith('p', { action: 'supersede', id: 'D-test', revision: 3, content: '只补缺失项', reason: '用户确认新范围' }))
})
it('keeps an unsaved edit on conflict for review instead of retrying against a fresh version', async () => {
  const { mutateEntry, changed } = setup()
  mutateEntry.mockRejectedValueOnce(new Error('条目修订冲突'))
  fireEvent.change(screen.getByLabelText('条目正文'), { target: { value: '修订草稿' } })
  fireEvent.change(screen.getByLabelText('条目原因'), { target: { value: '补充细节' } })
  fireEvent.click(screen.getByRole('button', { name: '保存条目' }))
  await screen.findByRole('alert')
  expect((screen.getByLabelText('条目正文') as HTMLTextAreaElement).value).toBe('修订草稿')
  expect(mutateEntry).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled()
})
