// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceReleaseController } from '../../core/release-command/types'
import { WorkspaceReleaseFailureCard } from './WorkspaceReleaseFailureCard'

afterEach(cleanup)

describe('WorkspaceReleaseFailureCard', () => {
  it('shows one workspace failure and opens its log', () => {
    const release = failedRelease()
    render(<WorkspaceReleaseFailureCard release={release} />)

    expect(screen.getByText('发布 0.7.7 失败')).toBeTruthy()
    expect(screen.getByText('提交并合并 PR')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看日志' }))
    expect(release.openLog).toHaveBeenCalledOnce()
  })
})

function failedRelease(): WorkspaceReleaseController {
  return {
    supported: true,
    currentVersion: '0.7.6',
    versions: ['0.7.7', '0.8.0'],
    loading: false,
    refresh: vi.fn(async () => undefined),
    status: {
      runId: 'release-1',
      workspaceRoot: '/repo',
      version: '0.7.7',
      status: 'failed',
      phase: 'submitting',
      error: 'required check failed',
      pid: 10,
      startedAt: 1,
      updatedAt: 2,
      completedAt: 2,
      dismissed: false,
    },
    start: vi.fn(async () => undefined),
    dismissFailure: vi.fn(async () => undefined),
    openLog: vi.fn(async () => undefined),
  }
}
