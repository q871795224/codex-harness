// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { CompassSettings } from './CompassSettings'

vi.mock('../../core/runtime/bridge', () => ({
  runtime: { getAppState: vi.fn(), compassHasKey: vi.fn(), saveCompassModel: vi.fn(), probeCompass: vi.fn() },
}))

afterEach(cleanup)

it('saves only the model and recognizes a key added to the shared file without reopening settings', async () => {
  vi.mocked(runtime.getAppState).mockResolvedValue(null)
  vi.mocked(runtime.compassHasKey).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  vi.mocked(runtime.saveCompassModel).mockResolvedValue('test-model')
  vi.mocked(runtime.probeCompass).mockResolvedValue(undefined)
  render(<CompassSettings />)

  await screen.findByText('尚未配置 Compass API Key')
  fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'test-model' } })
  expect((screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '保存模型' }))
  expect((await screen.findByRole('status')).textContent).toBe('已保存 Compass 模型')
  expect(runtime.saveCompassModel).toHaveBeenCalledWith('test-model')
  expect(runtime.probeCompass).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
  expect((await screen.findByRole('status')).textContent).toBe('Compass 连通性测试通过')
  expect(screen.getByText('已检测到 Compass API Key')).toBeTruthy()
  expect(runtime.probeCompass).toHaveBeenCalledWith()
})
