import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

it('passes local image paths and cwd through IPC and preserves binary bytes', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]).buffer
  vi.mocked(invoke).mockResolvedValueOnce(bytes)
  expect(await runtime.readMarkdownImage('截图.png', '/repo')).toBe(bytes)
  expect(invoke).toHaveBeenLastCalledWith('read_markdown_image', { path: '截图.png', cwd: '/repo' })
  vi.mocked(invoke).mockResolvedValueOnce([137, 80])
  expect(new Uint8Array(await runtime.readMarkdownImage('/tmp/pic.png'))).toEqual(new Uint8Array([137, 80]))
  expect(invoke).toHaveBeenLastCalledWith('read_markdown_image', { path: '/tmp/pic.png', cwd: null })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('missing'))
  await expect(runtime.readMarkdownImage('/missing.png')).rejects.toThrow('missing')
})
