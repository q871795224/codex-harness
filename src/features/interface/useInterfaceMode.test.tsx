// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { INTERFACE_MODE_KEY, useInterfaceMode } from './useInterfaceMode'
afterEach(cleanup)

it('restores the core mode without rewriting it or starting any execution', async () => {
  const storage = { getAppState: vi.fn(async () => 'team'), setAppState: vi.fn(async () => {}) }
  const { result } = renderHook(() => useInterfaceMode(storage, vi.fn()))
  await waitFor(() => expect(result.current.mode).toBe('team'))
  expect(result.current.teamVisited).toBe(true)
  expect(storage.setAppState).not.toHaveBeenCalled()
})
it('a late restore never overwrites an explicit choice and writes rapid switches in order', async () => {
  let resolve!: (v: string) => void
  const storage = { getAppState: () => new Promise<string>((r) => { resolve = r }), setAppState: vi.fn(async () => {}) }
  const { result } = renderHook(() => useInterfaceMode(storage, vi.fn()))
  act(() => { result.current.selectMode('team'); result.current.selectMode('conversation') })
  await act(async () => resolve('team'))
  expect(result.current.mode).toBe('conversation')
  expect(result.current.teamVisited).toBe(true)
  await waitFor(() => expect(storage.setAppState.mock.calls).toEqual([[INTERFACE_MODE_KEY, 'team'], [INTERFACE_MODE_KEY, 'conversation']]))
})
it('failed preference persistence does not block switching or discard the visited surface', async () => {
  const storage = { getAppState: vi.fn(async () => null), setAppState: vi.fn(async () => { throw new Error('disk full') }) }
  const report = vi.fn()
  const { result } = renderHook(() => useInterfaceMode(storage, report))
  act(() => result.current.selectMode('team'))
  await waitFor(() => expect(report).toHaveBeenCalled())
  expect(result.current.mode).toBe('team')
})
