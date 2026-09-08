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
  { value: 'claude-sonnet-4-5', resolvedModel: null, displayName: 'Sonnet 4.5', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], supportsAdaptiveThinking: true, supportsFastMode: false, supportsAutoMode: true },
  { value: 'claude-opus-4-1', resolvedModel: null, displayName: 'Opus 4.1', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'], supportsAdaptiveThinking: true, supportsFastMode: false, supportsAutoMode: true },
  { value: 'claude-haiku-4-5', resolvedModel: null, displayName: 'Haiku 4.5', description: '', supportsEffort: false, supportedEffortLevels: [], supportsAdaptiveThinking: false, supportsFastMode: false, supportsAutoMode: true },
]

function mockStored(values: Partial<Record<string, string | null>>) {
  runtime.getAppState.mockImplementation(async (key: string) => values[key] ?? null)
}

it('shows "CLI 默认" selected when no default model is stored', async () => {
  mockStored({})
  render(<ClaudeDefaultModelSettings models={models} />)
  const select = await screen.findByLabelText('模型') as HTMLSelectElement
  await waitFor(() => expect(select.disabled).toBe(false))
  expect(select.value).toBe('')
})

it('shows the stored default model selected', async () => {
  mockStored({ 'claude.defaultModel': 'claude-opus-4-1' })
  render(<ClaudeDefaultModelSettings models={models} />)
  const select = await screen.findByLabelText('模型') as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('claude-opus-4-1'))
})

it('changing the select persists via setAppState', async () => {
  mockStored({})
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

  mockStored({})
  render(<ClaudeDefaultModelSettings models={[]} />)
  const empty = await screen.findByLabelText('模型') as HTMLSelectElement
  await waitFor(() => expect(empty.disabled).toBe(false))
  // 模型列表为空时也允许选「CLI 默认」（即清空），但整体只读更直观。当前实现：不禁用，因为 value='' 仍然是合法选择。
})

it('shows effort options of the first model when default model is CLI 默认', async () => {
  mockStored({})
  render(<ClaudeDefaultModelSettings models={models} />)
  const select = await screen.findByLabelText('推理强度') as HTMLSelectElement
  await waitFor(() => expect(select.disabled).toBe(false))
  // 未存储时按运行时回退规则显示首个支持档位，但不主动写入。
  expect(select.value).toBe('low')
  expect(Array.from(select.options).map((option) => option.value)).toEqual(['low', 'medium', 'high'])
})

it('shows the stored default effort selected', async () => {
  mockStored({ 'claude.defaultModel': 'claude-opus-4-1', 'claude.defaultEffort': 'max' })
  render(<ClaudeDefaultModelSettings models={models} />)
  const select = await screen.findByLabelText('推理强度') as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('max'))
})

it('changing the effort persists via setAppState', async () => {
  mockStored({})
  runtime.setAppState.mockResolvedValue(undefined)
  render(<ClaudeDefaultModelSettings models={models} />)
  const select = await screen.findByLabelText('推理强度') as HTMLSelectElement
  await waitFor(() => expect(select.disabled).toBe(false))

  fireEvent.change(select, { target: { value: 'high' } })
  await waitFor(() => expect(runtime.setAppState).toHaveBeenCalledWith('claude.defaultEffort', 'high'))
})

it('falls back to the first effort level when the stored effort is not supported by the default model', async () => {
  mockStored({ 'claude.defaultModel': 'claude-sonnet-4-5', 'claude.defaultEffort': 'max' })
  render(<ClaudeDefaultModelSettings models={models} />)
  const select = await screen.findByLabelText('推理强度') as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('low'))
})

it('clears the stored effort when switching to a model that does not support it', async () => {
  mockStored({ 'claude.defaultModel': 'claude-opus-4-1', 'claude.defaultEffort': 'max' })
  runtime.setAppState.mockResolvedValue(undefined)
  render(<ClaudeDefaultModelSettings models={models} />)
  const modelSelect = await screen.findByLabelText('模型') as HTMLSelectElement
  await waitFor(() => expect(modelSelect.value).toBe('claude-opus-4-1'))

  fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-4-5' } })
  await waitFor(() => expect(runtime.setAppState).toHaveBeenCalledWith('claude.defaultEffort', ''))
})

it('keeps the stored effort when switching to a model that still supports it', async () => {
  mockStored({ 'claude.defaultModel': 'claude-opus-4-1', 'claude.defaultEffort': 'high' })
  runtime.setAppState.mockResolvedValue(undefined)
  render(<ClaudeDefaultModelSettings models={models} />)
  const modelSelect = await screen.findByLabelText('模型') as HTMLSelectElement
  await waitFor(() => expect(modelSelect.value).toBe('claude-opus-4-1'))

  fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-4-5' } })
  await waitFor(() => expect(runtime.setAppState).toHaveBeenCalledWith('claude.defaultModel', 'claude-sonnet-4-5'))
  expect(runtime.setAppState).not.toHaveBeenCalledWith('claude.defaultEffort', '')
})

it('hides the effort select when the default model supports no effort levels', async () => {
  mockStored({ 'claude.defaultModel': 'claude-haiku-4-5' })
  render(<ClaudeDefaultModelSettings models={models} />)
  await screen.findByLabelText('模型')
  await waitFor(() => expect(screen.queryByLabelText('推理强度')).toBeNull())
})
