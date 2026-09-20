// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { Markdown } from './Markdown'
import { imageSource } from './MarkdownImage'

vi.mock('../../core/runtime/bridge', () => ({ runtime: { readMarkdownImage: vi.fn() } }))
beforeEach(() => {
  vi.mocked(runtime.readMarkdownImage).mockResolvedValue(new Uint8Array([137, 80, 78, 71]).buffer)
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:preview')
    static revokeObjectURL = vi.fn()
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks() })

it('renders an absolute local path, opens a large image, closes with Escape and releases memory', async () => {
  const { unmount } = render(<Markdown text="![工作区设置](/Users/demo/output/workspace-settings.png)" cwd="/repo" />)
  const image = await screen.findByRole('img', { name: '工作区设置' })
  expect(runtime.readMarkdownImage).toHaveBeenCalledWith('/Users/demo/output/workspace-settings.png', '/repo')
  expect(image.getAttribute('src')).toBe('blob:preview')
  fireEvent.load(image)
  const preview = screen.getByRole('button', { name: '查看大图：工作区设置' })
  preview.focus()
  fireEvent.click(preview)
  expect(screen.getByRole('dialog', { name: '查看图片：工作区设置' })).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭图片' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(preview)
  unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
})

it('resolves encoded relative and file URLs without rereading on a streamed text update', async () => {
  const { rerender } = render(<Markdown text="![图](<output/中文 图.png>)" cwd="/repo" />)
  await screen.findByRole('img')
  expect(runtime.readMarkdownImage).toHaveBeenLastCalledWith('output/中文 图.png', '/repo')
  rerender(<Markdown text="![图](<output/中文 图.png>)\n\n更多内容" cwd="/repo" />)
  expect(runtime.readMarkdownImage).toHaveBeenCalledTimes(1)
  rerender(<Markdown text="![图](file:///tmp/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png)" />)
  await waitFor(() => expect(runtime.readMarkdownImage).toHaveBeenLastCalledWith('/tmp/中文 图.png', undefined))
})

it('shows missing-file and decode failures instead of a broken image or enabled zoom button', async () => {
  vi.mocked(runtime.readMarkdownImage).mockRejectedValueOnce(new Error('文件不存在'))
  const { rerender } = render(<Markdown text="![missing](/missing.png)" />)
  expect(await screen.findByRole('status')).toHaveProperty('textContent', '图片加载失败：文件不存在')
  expect((screen.getByRole('button', { name: '放大图片：missing' }) as HTMLButtonElement).disabled).toBe(true)
  rerender(<Markdown text="![remote](https://example.com/image.png)" />)
  fireEvent.error(await screen.findByRole('img'))
  expect(screen.getByRole('status').textContent).toContain('无法解码')
})

it('ignores a pending local read after unmount', async () => {
  let resolve!: (bytes: ArrayBuffer) => void
  vi.mocked(runtime.readMarkdownImage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const { unmount } = render(<Markdown text="![图](/late.png)" />)
  unmount()
  await act(async () => { resolve(new ArrayBuffer(0)) })
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it('does not treat remote or unsafe protocols as local file paths', () => {
  expect(imageSource('https://example.com/a.png')).toEqual({ kind: 'remote', value: 'https://example.com/a.png' })
  expect(imageSource('file://localhost/tmp/a.png')).toEqual({ kind: 'local', value: '/tmp/a.png' })
  for (const src of ['javascript:alert(1)', 'data:text/html,test', 'file://remote/tmp/a.png', '%00.png', '%broken']) expect(imageSource(src)).toBeNull()
})
