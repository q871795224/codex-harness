// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'
import { writeClipboard } from './clipboard'

vi.mock('./clipboard', () => ({ writeClipboard: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./MermaidBlock', () => ({ MermaidBlock: () => null }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

it('copies quote text with paragraph breaks and inline formatting removed', async () => {
  const { container } = render(<Markdown text={'外面的正文\n\n> 请以 `62c051cd` 为基线，**对比修复**。\n>\n> 第二段见 [文档](https://example.com)。'} />)
  expect(container.querySelector('blockquote strong')?.textContent).toBe('对比修复')
  fireEvent.click(screen.getByRole('button', { name: '复制引用' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '复制引用' }).textContent).toBe('已复制'))
  expect(writeClipboard).toHaveBeenCalledWith('请以 62c051cd 为基线，对比修复。\n\n第二段见 文档。')
})

it('copies nested quotes independently without including copy controls', async () => {
  render(<Markdown text={'> 外层\n>\n>> 内层\n>\n> ```ts\n> const a = 1\n> ```'} />)
  const [inner, outer] = screen.getAllByRole('button', { name: '复制引用' })
  fireEvent.click(inner)
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('内层'))
  fireEvent.click(outer)
  await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith('外层\n\n内层\n\nconst a = 1'))
  expect(screen.getByRole('button', { name: '复制代码' })).toBeTruthy()
})

it('copies the latest streamed content and keeps separate quotes independent', async () => {
  const { rerender } = render(<Markdown text={'> 开始'} />)
  rerender(<Markdown text={'> 开始，补全内容。\n\n正文\n\n> 另一段引用'} />)
  const [first, second] = screen.getAllByRole('button', { name: '复制引用' })
  fireEvent.click(first)
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('开始，补全内容。'))
  expect(second.textContent).toBe('复制')
  fireEvent.click(second)
  await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith('另一段引用'))
})

it('shows clipboard failure and resets feedback after retry', async () => {
  vi.useFakeTimers()
  vi.mocked(writeClipboard).mockRejectedValueOnce(new Error('clipboard unavailable'))
  render(<Markdown text={'> 引用'} />)
  const button = screen.getByRole('button', { name: '复制引用' })
  await act(async () => fireEvent.click(button))
  expect(button.textContent).toBe('失败')
  expect(button.title).toBe('复制失败')
  await act(async () => fireEvent.click(button))
  expect(button.textContent).toBe('已复制')
  await act(async () => vi.advanceTimersByTime(1_500))
  expect(button.textContent).toBe('复制')
})
