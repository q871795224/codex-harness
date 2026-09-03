// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceReleaseController } from '../release-command/types'
import { QuickCommandPanel } from './QuickCommandPanel'

afterEach(cleanup)

describe('QuickCommandPanel workspace release', () => {
  it('offers the two target versions and starts the selected release', async () => {
    const release = controller()
    render(<QuickCommandPanel commands={[]} release={release} />)

    fireEvent.click(screen.getByRole('button', { name: '打开快捷命令' }))
    fireEvent.click(screen.getByRole('button', { name: '发布 Codex Harness' }))
    expect(await screen.findByRole('menuitem', { name: '0.7.7' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '0.8.0' })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: '0.7.7' }))
    await waitFor(() => expect(release.start).toHaveBeenCalledWith('0.7.7'))
  })

  it('does not add the release command for another workspace', () => {
    render(<QuickCommandPanel commands={[]} release={controller({ supported: false })} />)
    expect(screen.queryByRole('button', { name: '打开快捷命令' })).toBeNull()
  })
})

function controller(overrides: Partial<WorkspaceReleaseController> = {}): WorkspaceReleaseController {
  return {
    supported: true,
    currentVersion: '0.7.6',
    versions: ['0.7.7', '0.8.0'],
    status: null,
    loading: false,
    refresh: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    dismissFailure: vi.fn(async () => undefined),
    openLog: vi.fn(async () => undefined),
    ...overrides,
  }
}
