// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { ImageViewItem, WebSearchItem, webActivity } from './BrowsingActivity'

vi.mock('../../core/runtime/bridge', () => ({ runtime: { readMarkdownImage: vi.fn() } }))
beforeEach(() => {
  vi.mocked(runtime.readMarkdownImage).mockResolvedValue(new ArrayBuffer(4))
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:preview')
    static revokeObjectURL = vi.fn()
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks() })

it('shows all batch queries and expands their full text', () => {
  render(<WebSearchItem item={{ type: 'webSearch', status: 'completed', action: { type: 'search', query: 'first', queries: ['first', 'second'] } }} />)
  const button = screen.getByRole('button', { name: /搜索网页/ })
  expect(button.textContent).toContain('first · second')
  fireEvent.click(button)
  expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['first', 'second'])
  expect(button.getAttribute('aria-expanded')).toBe('true')
})

it('distinguishes opening, finding, legacy queries and unknown actions', () => {
  expect(webActivity({ type: 'webSearch', action: { type: 'openPage', url: 'https://example.com' } })).toEqual({ label: '打开网页', details: ['https://example.com'] })
  expect(webActivity({ type: 'webSearch', action: { type: 'findInPage', url: 'https://example.com', pattern: 'token' } })).toEqual({ label: '页内查找', details: ['token', 'https://example.com'] })
  expect(webActivity({ type: 'webSearch', query: 'legacy' }).details).toEqual(['legacy'])
  expect(webActivity({ type: 'webSearch', action: { type: 'other' } })).toEqual({ label: '浏览网页', details: [] })
  expect(webActivity({ type: 'webSearch', action: { type: 'search', queries: [null, 1, 'valid'] } }).details).toEqual(['valid'])
})

it('renders the filename, exact path and an expandable local image', async () => {
  const path = '/tmp/中文 100% #1?.png'
  render(<ImageViewItem item={{ type: 'imageView', path }} cwd="/repo" />)
  expect(screen.getByText(path)).toBeTruthy()
  const image = await screen.findByRole('img', { name: '中文 100% #1?.png' })
  expect(runtime.readMarkdownImage).toHaveBeenCalledWith(path, '/repo')
  fireEvent.load(image)
  fireEvent.click(screen.getByRole('button', { name: '查看大图：中文 100% #1?.png' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('keeps the path visible when a historical image is missing', async () => {
  vi.mocked(runtime.readMarkdownImage).mockRejectedValue(new Error('文件不存在'))
  render(<ImageViewItem item={{ type: 'imageView', path: 'output/gone.png' }} cwd="/repo" />)
  expect((await screen.findByRole('status')).textContent).toContain('文件不存在')
  expect(screen.getByText('output/gone.png')).toBeTruthy()
  expect(runtime.readMarkdownImage).toHaveBeenCalledWith('output/gone.png', '/repo')
})

it('handles image events with no path without reading files', () => {
  render(<ImageViewItem item={{ type: 'imageView' }} cwd="/repo" />)
  expect(screen.getByText('未提供路径')).toBeTruthy()
  expect(runtime.readMarkdownImage).not.toHaveBeenCalled()
})
