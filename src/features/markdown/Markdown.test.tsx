// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  openWorkspacePath: vi.fn(),
  recordClientDiagnostic: vi.fn(),
}))

vi.mock('../../core/runtime/bridge', () => ({
  runtime,
  diagnosticErrorCode: () => 'request_failed',
}))

vi.mock('./MermaidBlock', () => ({
  MermaidBlock: ({ code }: { code: string }) => <div data-testid="mermaid-block">{code}</div>,
}))

import { Markdown } from './Markdown'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('renders markdown content', () => {
  render(<Markdown text={'# 标题\n\n正文 **加粗**'} />)
  expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy()
  expect(screen.getByText('加粗').tagName).toBe('STRONG')
})

it('renders mermaid fenced blocks with the MermaidBlock component', () => {
  render(<Markdown text={'```mermaid\ngraph TD; A-->B\n```'} />)
  expect(screen.getByTestId('mermaid-block').textContent).toBe('graph TD; A-->B')
})

it('keeps regular code blocks as code blocks with a copy button', () => {
  render(<Markdown text={'```ts\nconst a = 1\n```'} />)
  expect(screen.queryByTestId('mermaid-block')).toBeNull()
  expect(screen.getByRole('button', { name: '复制代码' })).toBeTruthy()
  expect(screen.getByText('const a = 1')).toBeTruthy()
})

it('does not treat inline code as a mermaid block', () => {
  render(<Markdown text={'这是 `mermaid` 内联代码'} />)
  expect(screen.queryByTestId('mermaid-block')).toBeNull()
  expect(screen.getByText('mermaid').tagName).toBe('CODE')
})

it('opens external links through the runtime when cwd is provided', () => {
  runtime.openExternalUrl.mockResolvedValue(undefined)
  render(<Markdown text={'[docs](https://example.com/docs)'} cwd="/repo" />)
  fireEvent.click(screen.getByRole('link', { name: /docs/ }))
  expect(runtime.openExternalUrl).toHaveBeenCalledWith('https://example.com/docs')
})

it('renders plain anchors when no cwd is provided', () => {
  render(<Markdown text={'[docs](https://example.com/docs)'} />)
  const link = screen.getByRole('link', { name: 'docs' })
  expect(link.getAttribute('href')).toBe('https://example.com/docs')
})
