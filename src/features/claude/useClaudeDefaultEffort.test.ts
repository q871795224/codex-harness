// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  getAppState: vi.fn(),
  setAppState: vi.fn(),
}))

vi.mock('../../core/runtime/bridge', () => ({ runtime }))

import { CLAUDE_DEFAULT_EFFORT_KEY, useClaudeDefaultEffort } from './useClaudeDefaultEffort'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('loads null default effort when the key is missing', async () => {
  runtime.getAppState.mockResolvedValue(null)
  const { result } = renderHook(() => useClaudeDefaultEffort())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  expect(result.current.defaultEffort).toBeNull()
  expect(runtime.getAppState).toHaveBeenCalledWith(CLAUDE_DEFAULT_EFFORT_KEY)
})

it('loads the stored default effort', async () => {
  runtime.getAppState.mockResolvedValue('high')
  const { result } = renderHook(() => useClaudeDefaultEffort())
  await waitFor(() => expect(result.current.defaultEffort).toBe('high'))
})

it('setDefaultEffort persists and updates state', async () => {
  runtime.getAppState.mockResolvedValue(null)
  runtime.setAppState.mockResolvedValue(undefined)
  const { result } = renderHook(() => useClaudeDefaultEffort())
  await waitFor(() => expect(result.current.loaded).toBe(true))

  await act(async () => { await result.current.setDefaultEffort('max') })
  expect(result.current.defaultEffort).toBe('max')
  expect(runtime.setAppState).toHaveBeenCalledWith(CLAUDE_DEFAULT_EFFORT_KEY, 'max')

  await act(async () => { await result.current.setDefaultEffort(null) })
  expect(result.current.defaultEffort).toBeNull()
  expect(runtime.setAppState).toHaveBeenCalledWith(CLAUDE_DEFAULT_EFFORT_KEY, '')
})

it('treats empty stored string as null', async () => {
  runtime.getAppState.mockResolvedValue('')
  const { result } = renderHook(() => useClaudeDefaultEffort())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  expect(result.current.defaultEffort).toBeNull()
})
