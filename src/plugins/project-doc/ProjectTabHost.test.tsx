// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import { archiveStore } from './archiveStore'
import { ProjectTabHost } from './index'

afterEach(() => {
  cleanup()
  archiveStore.clearOpen()
  archiveStore.clearSelect()
})

const meta = { projectId: 'demo', name: '示例项目', currentSeq: 2, createdAt: 1, updatedAt: 1 }

function service(): ProjectDocService {
  return {
    create: vi.fn(async () => meta), list: vi.fn(async () => [meta]), get: vi.fn(async () => meta),
    rename: vi.fn(async () => undefined), archive: vi.fn(async () => undefined),
    read: vi.fn(async () => ({ projectId: 'demo', currentSeq: 2, content: '', contentHash: 'h', consistent: true })),
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

it('opens the selected project when selectRequest fires (no archive view)', async () => {
  render(<ProjectTabHost service={service()} />)
  // 初始在项目列表
  await screen.findByRole('heading', { name: /项目文档/ })
  expect(screen.queryByTitle('返回项目列表')).toBeNull()

  // 触发 selectRequest：应跳到该项目的详情页（出现「返回项目列表」按钮）
  act(() => { archiveStore.requestSelect('demo') })
  await screen.findByTitle('返回项目列表')

  // 不应进入 archive 视图（没有「归档确认」标题）
  expect(screen.queryByText(/归档确认/)).toBeNull()

  // selectRequest 被消费后清空
  await waitFor(() => expect(archiveStore.getState().selectRequest).toBeNull())
})
