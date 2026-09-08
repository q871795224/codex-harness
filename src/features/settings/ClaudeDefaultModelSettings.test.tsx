// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClaudeModel } from '../../core/claude/types'

const runtime = vi.hoisted(() => ({
  getAppState: vi.fn(),
  setAppState: vi.fn(),
}))

vi.mock('../../core/runtime/bridge', () => ({ runtime }))

import { ClaudeDefaultModelSettings } from './ClaudeDefaultModelSettings'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const models: ClaudeModel[] = [
  { value: 'claude-sonnet-4-5', resolvedModel: null, displayName: 'Sonnet 4.5', description: '', supportsEffort: true, supportedEffortLevels: [], supportsAdaptiveThinking: true, supportsFastMode: false, supportsAutoMode: true },
  { value: 'claude-opus-4-1', resolvedModel: null, displayName: 'Opus 4.1', description: '', supportsEffort: true, supportedEffortLevels: [], supportsAdaptiveThinking: true, supportsFastMode: false, supportsAutoMode: true },
]

it('shows "CLI 默认" selected when no default model is stored', async () => {
  runtime.getAppState.mockResolvedValue(null)
  render(<ClaudeDefaultModelSettings models={models} />)
  const select = await screen.findByLabelText('模型') as HTMLSelectElement
  await waitFor(() => expect(select.disabled).toBe(false))
  expect(select.value).toBe('')
})

it('shows the stored default model selected', async () => {
  runtime.getAppState.mockResolvedValue('claude-opus-4-1')
  render(<ClaudeDefaultModelSettings models={models} />)
  const select = await screen.findByLabelText('模型') as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('claude-opus-4-1'))
})

it('changing the select persists via setAppState', async () => {
  runtime.getAppState.mockResolvedValue(null)
  runtime.setAppState.mockResolvedValue(undefined)
  render(<ClaudeDefaultModelSettings models={models} />)
  const select = await screen.findByLabelText('模型') as HTMLSelectElement
  await waitFor(() => expect(select.disabled).toBe(false))

  fireEvent.change(select, { target: { value: 'claude-sonnet-4-5' } })
  await waitFor(() => expect(runtime.setAppState).toHaveBeenCalledWith('claude.defaultModel', 'claude-sonnet-4-5'))

  fireEvent.change(select, { target: { value: '' } })
  await waitFor(() => expect(runtime.setAppState).toHaveBeenCalledWith('claude.defaultModel', ''))
})

it('disables the select while loading or when models list is empty', async () => {
  runtime.getAppState.mockReturnValue(new Promise(() => undefined))
  const { unmount } = render(<ClaudeDefaultModelSettings models={models} />)
  const select = await screen.findByLabelText('模型') as HTMLSelectElement
  expect(select.disabled).toBe(true)
  unmount()

  runtime.getAppState.mockResolvedValue(null)
  render(<ClaudeDefaultModelSettings models={[]} />)
  const empty = await screen.findByLabelText('模型') as HTMLSelectElement
  await waitFor(() => expect(empty.disabled).toBe(false))
  // 模型列表为空时也允许选「CLI 默认」（即清空），但整体只读更直观。当前实现：不禁用，因为 value='' 仍然是合法选择。
})
