// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { CompassSettings } from './CompassSettings'

vi.mock('../../core/runtime/bridge', () => ({
  runtime: { compassStatus: vi.fn(), saveCompass: vi.fn(), probeCompass: vi.fn(), removeCompass: vi.fn() },
}))

afterEach(cleanup)

it('saves configuration, clears the secret field, and tests the saved model on demand', async () => {
  vi.mocked(runtime.compassStatus).mockResolvedValue({ supported: true, model: null })
  vi.mocked(runtime.saveCompass).mockResolvedValue({ supported: true, model: 'test-model' })
  vi.mocked(runtime.probeCompass).mockResolvedValue(undefined)
  vi.mocked(runtime.removeCompass).mockResolvedValue(undefined)
  render(<CompassSettings />)

  const key = await screen.findByPlaceholderText('输入 Compass API Key')
  fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'test-model' } })
  fireEvent.change(key, { target: { value: 'fake-key' } })
  expect((screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  expect((await screen.findByRole('status')).textContent).toBe('已保存 Compass 配置')
  expect(runtime.saveCompass).toHaveBeenCalledWith('test-model', 'fake-key')
  expect((key as HTMLInputElement).value).toBe('')
  expect(runtime.probeCompass).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
  expect((await screen.findByRole('status')).textContent).toBe('Compass 连通性测试通过')
  expect(runtime.probeCompass).toHaveBeenCalledWith()

  fireEvent.click(screen.getByRole('button', { name: '清除配置' }))
  expect((await screen.findByRole('status')).textContent).toBe('已清除 Compass 配置')
  expect(runtime.removeCompass).toHaveBeenCalledWith()
})
