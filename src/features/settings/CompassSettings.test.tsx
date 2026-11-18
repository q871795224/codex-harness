// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { CompassSettings } from './CompassSettings'

vi.mock('../../core/runtime/bridge', () => ({
  runtime: { getAppState: vi.fn(), compassHasKey: vi.fn(), saveCompassKey: vi.fn(), saveCompassModel: vi.fn(), probeCompass: vi.fn() },
}))

afterEach(cleanup)

it('saves and clears the password field, then tests with the saved key and model', async () => {
  vi.mocked(runtime.getAppState).mockResolvedValue(null)
  vi.mocked(runtime.compassHasKey).mockResolvedValue(true).mockResolvedValueOnce(false)
  vi.mocked(runtime.saveCompassModel).mockResolvedValue('test-model')
  vi.mocked(runtime.saveCompassKey).mockResolvedValue(undefined)
  vi.mocked(runtime.probeCompass).mockResolvedValue(undefined)
  render(<CompassSettings />)

  const key = await screen.findByLabelText('API Key') as HTMLInputElement
  await waitFor(() => expect(key.disabled).toBe(false))
  fireEvent.change(key, { target: { value: 'fake-key' } })
  fireEvent.click(screen.getByRole('button', { name: '保存密钥' }))
  expect((await screen.findByRole('status')).textContent).toBe('已保存 Compass API Key')
  expect(runtime.saveCompassKey).toHaveBeenCalledWith('fake-key')
  expect(key.value).toBe('')
  expect(key.placeholder).toBe('已保存，输入新密钥可替换')
  fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'test-model' } })
  expect((screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '保存模型' }))
  expect((await screen.findByRole('status')).textContent).toBe('已保存 Compass 模型')
  expect(runtime.saveCompassModel).toHaveBeenCalledWith('test-model')
  expect(runtime.probeCompass).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
  expect((await screen.findByRole('status')).textContent).toBe('Responses 连通性测试通过')
  expect(runtime.probeCompass).toHaveBeenNthCalledWith(1, 'responses')

  fireEvent.change(screen.getByLabelText('测试接口'), { target: { value: 'chatCompletions' } })
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
  expect((await screen.findByRole('status')).textContent).toBe('Chat Completions 连通性测试通过')
  expect(runtime.probeCompass).toHaveBeenNthCalledWith(2, 'chatCompletions')
})
