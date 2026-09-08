// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  getAppState: vi.fn(),
  setAppState: vi.fn(),
}))

vi.mock('../../core/runtime/bridge', () => ({ runtime }))

import { CLAUDE_DEFAULT_MODEL_KEY, useClaudeDefaultModel } from './useClaudeDefaultModel'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('loads null default model when the key is missing', async () => {
  runtime.getAppState.mockResolvedValue(null)
  const { result } = renderHook(() => useClaudeDefaultModel())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  expect(result.current.defaultModel).toBeNull()
  expect(runtime.getAppState).toHaveBeenCalledWith(CLAUDE_DEFAULT_MODEL_KEY)
})

it('loads the stored default model', async () => {
  runtime.getAppState.mockResolvedValue('claude-sonnet-4-5')
  const { result } = renderHook(() => useClaudeDefaultModel())
  await waitFor(() => expect(result.current.defaultModel).toBe('claude-sonnet-4-5'))
})

it('setDefaultModel persists and updates state', async () => {
  runtime.getAppState.mockResolvedValue(null)
  runtime.setAppState.mockResolvedValue(undefined)
  const { result } = renderHook(() => useClaudeDefaultModel())
  await waitFor(() => expect(result.current.loaded).toBe(true))

  await act(async () => { await result.current.setDefaultModel('claude-opus-4-1') })
  expect(result.current.defaultModel).toBe('claude-opus-4-1')
  expect(runtime.setAppState).toHaveBeenCalledWith(CLAUDE_DEFAULT_MODEL_KEY, 'claude-opus-4-1')

  await act(async () => { await result.current.setDefaultModel(null) })
  expect(result.current.defaultModel).toBeNull()
  expect(runtime.setAppState).toHaveBeenCalledWith(CLAUDE_DEFAULT_MODEL_KEY, '')
})

it('treats empty stored string as null', async () => {
  runtime.getAppState.mockResolvedValue('')
  const { result } = renderHook(() => useClaudeDefaultModel())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  expect(result.current.defaultModel).toBeNull()
})
