// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

import { MarkdownLink } from './ConversationView'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('opens http(s) links in the system browser without logging on success', () => {
  runtime.openExternalUrl.mockResolvedValue(undefined)
  render(<MarkdownLink href="https://example.com/docs" cwd="/repo">docs</MarkdownLink>)
  fireEvent.click(screen.getByRole('link', { name: /docs/ }))
  expect(runtime.openExternalUrl).toHaveBeenCalledWith('https://example.com/docs')
  expect(runtime.recordClientDiagnostic).not.toHaveBeenCalled()
})

it('records an error diagnostic when opening an external link fails', async () => {
  runtime.openExternalUrl.mockRejectedValue(new Error('opener blew up'))
  runtime.recordClientDiagnostic.mockResolvedValue(undefined)
  render(<MarkdownLink href="https://example.com/docs" cwd="/repo">docs</MarkdownLink>)
  fireEvent.click(screen.getByRole('link', { name: /docs/ }))
  await waitFor(() => expect(runtime.recordClientDiagnostic).toHaveBeenCalledTimes(1))
  expect(runtime.recordClientDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
    level: 'error',
    area: 'frontend',
    event: 'markdown-link.open-failed',
    context: { kind: 'external', href: 'https://example.com/docs' },
    errorCode: 'request_failed',
    reason: 'opener blew up',
  }))
})

it('opens mailto links in the system browser', () => {
  runtime.openExternalUrl.mockResolvedValue(undefined)
  render(<MarkdownLink href="mailto:team@example.com" cwd="/repo">mail</MarkdownLink>)
  fireEvent.click(screen.getByRole('link', { name: /mail/ }))
  expect(runtime.openExternalUrl).toHaveBeenCalledWith('mailto:team@example.com')
})

it('treats a bare filename href as a local file reference', () => {
  runtime.openWorkspacePath.mockResolvedValue(undefined)
  render(<MarkdownLink href="README.md" cwd="/repo">readme</MarkdownLink>)
  fireEvent.click(screen.getByRole('button', { name: 'readme' }))
  expect(runtime.openWorkspacePath).toHaveBeenCalledWith('goland', '/repo', 'README.md', undefined)
})

it('records an error diagnostic when opening a local file link fails', async () => {
  runtime.openWorkspacePath.mockRejectedValue(new Error('goland missing'))
  runtime.recordClientDiagnostic.mockResolvedValue(undefined)
  render(<MarkdownLink href="src/main.go" cwd="/repo">main.go</MarkdownLink>)
  fireEvent.click(screen.getByRole('button', { name: 'main.go' }))
  await waitFor(() => expect(runtime.recordClientDiagnostic).toHaveBeenCalledTimes(1))
  expect(runtime.recordClientDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
    level: 'error',
    event: 'markdown-link.open-failed',
    context: { kind: 'local', href: 'src/main.go' },
    reason: 'goland missing',
  }))
})

it('renders blocked schemes as inert text', () => {
  render(<MarkdownLink href="javascript:alert(1)" cwd="/repo">x</MarkdownLink>)
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('x')).toBeTruthy()
})
