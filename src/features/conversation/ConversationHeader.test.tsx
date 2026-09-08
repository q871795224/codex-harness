// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Thread, Workspace } from '../../core/domain/codex'
import { ConversationHeader } from './ConversationView'

afterEach(cleanup)

function makeThread(): Thread {
  return {
    id: 'thread-1',
    preview: '',
    cwd: '/repo',
    name: null,
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: 'idle' },
    ephemeral: false,
    canAcceptDirectInput: true,
  }
}

const workspace: Workspace = {
  root: '/repo',
  checkoutRoot: '/repo',
  name: 'demo-workspace',
  branch: 'main',
  sha: null,
  createdAt: 1,
  lastOpenedAt: 1,
}

function renderHeader(overrides: Partial<Parameters<typeof ConversationHeader>[0]> = {}) {
  const props: Parameters<typeof ConversationHeader>[0] = {
    thread: makeThread(),
    workspace,
    gitContextResolved: true,
    archived: false,
    pinned: false,
    workspaceChanging: false,
    canChangeWorkspace: true,
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onTogglePinned: vi.fn(),
    onChooseWorkspace: vi.fn(),
    ...overrides,
  }
  return render(<ConversationHeader {...props} />)
}

it('shows an inert "项目: -" chip when no project is bound', () => {
  renderHeader({ projectName: null, onOpenProject: vi.fn() })
  const chip = screen.getByTitle('未绑定项目')
  expect(chip.textContent).toContain('-')
  // 未绑定不可点
  expect((chip as HTMLButtonElement).disabled).toBe(true)
})

it('shows the bound project name and clicking it opens the project', () => {
  const onOpenProject = vi.fn()
  renderHeader({ projectName: '示例项目', onOpenProject })
  const chip = screen.getByTitle('打开项目文档')
  expect(chip.textContent).toContain('示例项目')
  expect((chip as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(chip)
  expect(onOpenProject).toHaveBeenCalledTimes(1)
})
