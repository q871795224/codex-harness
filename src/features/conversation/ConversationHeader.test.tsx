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
    isWorking: false,
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

it('hides the project chip when no project is bound', () => {
  renderHeader({ projectName: null, onOpenProject: vi.fn() })
  expect(screen.queryByTitle('未绑定项目')).toBeNull()
  expect(screen.queryByTitle('打开项目文档')).toBeNull()
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

it('disables archive during execution and enables it once execution ends', () => {
  const onArchive = vi.fn()
  const view = renderHeader({ isWorking: true, onArchive })
  const archive = screen.getByRole('button', { name: '归档' }) as HTMLButtonElement
  expect(archive.disabled).toBe(true)
  fireEvent.click(archive)
  expect(onArchive).not.toHaveBeenCalled()

  view.unmount()
  renderHeader({ isWorking: false, onArchive })
  const idleArchive = screen.getByRole('button', { name: '归档' }) as HTMLButtonElement
  expect(idleArchive.disabled).toBe(false)
  fireEvent.click(idleArchive)
  expect(onArchive).toHaveBeenCalledTimes(1)
})

it('keeps restore available for archived conversations', () => {
  const onUnarchive = vi.fn()
  renderHeader({ archived: true, isWorking: true, onUnarchive })
  const restore = screen.getByRole('button', { name: '恢复' }) as HTMLButtonElement
  expect(restore.disabled).toBe(false)
  fireEvent.click(restore)
  expect(onUnarchive).toHaveBeenCalledTimes(1)
})
