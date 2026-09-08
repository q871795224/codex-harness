// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseCommandInfo, ReleaseRunStatus } from './types'

const runtime = vi.hoisted(() => ({
  releaseCommandInfo: vi.fn(),
  releaseCommandStatus: vi.fn(),
  startReleaseCommand: vi.fn(),
  dismissReleaseFailure: vi.fn(),
  openReleaseLog: vi.fn(),
}))

vi.mock('../runtime/bridge', () => ({ runtime }))

import { useWorkspaceRelease } from './useWorkspaceRelease'

afterEach(cleanup)

describe('useWorkspaceRelease', () => {
  it('coalesces a refresh and starts from its fetched origin/main snapshot', async () => {
    const initial = info('initial-sha')
    const fetched = info('fetched-sha')
    const deferred = deferredValue<ReleaseCommandInfo>()
    runtime.releaseCommandInfo.mockResolvedValueOnce(initial)
    runtime.releaseCommandInfo.mockReturnValueOnce(deferred.promise)
    runtime.releaseCommandStatus.mockResolvedValue(null)
    runtime.startReleaseCommand.mockResolvedValue(status())

    const { result } = renderHook(() => useWorkspaceRelease('/repo'))
    await waitFor(() => expect(result.current.currentVersion).toBe('0.7.6'))

    let firstRefresh!: Promise<void>
    let secondRefresh!: Promise<void>
    act(() => {
      firstRefresh = result.current.refresh()
      secondRefresh = result.current.refresh()
    })
    expect(runtime.releaseCommandInfo).toHaveBeenCalledTimes(2)
    expect(runtime.releaseCommandInfo).toHaveBeenLastCalledWith('/repo', true)

    let start!: Promise<void>
    act(() => { start = result.current.start('0.7.7') })
    expect(runtime.startReleaseCommand).not.toHaveBeenCalled()

    await act(async () => {
      deferred.resolve(fetched)
      await Promise.all([firstRefresh, secondRefresh, start])
    })
    expect(runtime.startReleaseCommand).toHaveBeenCalledWith('/repo', '0.7.7', 'fetched-sha')
  })
})

function info(originMainSha: string): ReleaseCommandInfo {
  return {
    supported: true,
    currentVersion: '0.7.6',
    installedVersion: '0.7.6',
    versions: ['0.7.7', '0.8.0'],
    originMainSha,
    status: null,
  }
}

function status(): ReleaseRunStatus {
  return {
    runId: 'release-1',
    workspaceRoot: '/repo',
    version: '0.7.7',
    status: 'running',
    phase: 'starting',
    error: null,
    warning: false,
    pid: 1,
    startedAt: 1,
    updatedAt: 1,
    completedAt: null,
    dismissed: false,
  }
}

function deferredValue<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}
