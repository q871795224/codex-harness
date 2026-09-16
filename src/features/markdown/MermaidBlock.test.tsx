// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mermaidApi = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}))

vi.mock('mermaid', () => ({ default: mermaidApi }))

const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }))

import { MermaidBlock } from './MermaidBlock'

const CODE = 'graph TD; A-->B'
const SVG = '<svg data-testid="mermaid-diagram"><text>A</text></svg>'

beforeEach(() => {
  mermaidApi.render.mockResolvedValue({ svg: SVG })
  clipboard.writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

it('renders the chart view by default', async () => {
  render(<MermaidBlock code={CODE} />)
  await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeTruthy())
  expect(mermaidApi.initialize).toHaveBeenCalledWith(expect.objectContaining({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'default',
  }))
  expect(mermaidApi.render).toHaveBeenCalledWith(expect.any(String), CODE)
})

it('uses the dark mermaid theme when the app shell is dark', async () => {
  const shell = document.createElement('div')
  shell.className = 'app-shell'
  shell.setAttribute('data-theme', 'dark')
  document.body.appendChild(shell)

  render(<MermaidBlock code={CODE} />)
  await waitFor(() => expect(mermaidApi.initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' })))
})

it('switches between chart and code views', async () => {
  render(<MermaidBlock code={CODE} />)
  await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeTruthy())

  fireEvent.click(screen.getByRole('button', { name: '代码' }))
  expect(screen.getByText(CODE)).toBeTruthy()
  expect(screen.queryByTestId('mermaid-diagram')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '图表' }))
  expect(screen.getByTestId('mermaid-diagram')).toBeTruthy()
  expect(screen.queryByText(CODE)).toBeNull()
})

it('copies the mermaid source to the clipboard', async () => {
  render(<MermaidBlock code={CODE} />)
  fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
  await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(CODE))
  await waitFor(() => expect(screen.getByRole('button', { name: '复制代码' }).textContent).toContain('已复制'))
})

it('expands the diagram in a modal and closes it via the close button', async () => {
  render(<MermaidBlock code={CODE} />)
  await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeTruthy())

  fireEvent.click(screen.getByRole('button', { name: '放大图表' }))
  const dialog = screen.getByRole('dialog')
  expect(dialog.querySelector('[data-testid="mermaid-diagram"]')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('closes the modal with Escape and by clicking the backdrop', async () => {
  render(<MermaidBlock code={CODE} />)
  await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeTruthy())

  fireEvent.click(screen.getByRole('button', { name: '放大图表' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '放大图表' }))
  const backdrop = screen.getByRole('dialog').parentElement
  expect(backdrop).toBeTruthy()
  fireEvent.mouseDown(backdrop!)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('falls back to the code view with an error note when rendering fails', async () => {
  mermaidApi.render.mockRejectedValue(new Error('Parse error on line 1'))
  render(<MermaidBlock code={CODE} />)

  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Parse error on line 1'))
  expect(screen.getByText(CODE)).toBeTruthy()
  expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
})
