// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  openWorkspacePath: vi.fn(),
  recordClientDiagnostic: vi.fn(),
}))

vi.mock('../../core/runtime/bridge', () => ({
  runtime,
  diagnosticErrorCode: () => 'request_failed',
}))

import { isOpenableExternalUrl, MarkdownLink, parseLocalFileReference } from './MarkdownLink'

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

describe('destination hint', () => {
  it('does not show the destination hint when the href is just the percent-encoded label', () => {
    const { container } = render(
      <MarkdownLink href="https://x.com/%E6%B5%8B%E8%AF%95" cwd="/repo">{'https://x.com/测试'}</MarkdownLink>,
    )
    expect(container.querySelector('.link-destination')).toBeNull()
  })

  it('keeps showing the destination hint when the label differs from the href', () => {
    const { container } = render(<MarkdownLink href="https://x.com/docs" cwd="/repo">文档</MarkdownLink>)
    expect(container.querySelector('.link-destination')?.textContent).toBe(' (https://x.com/docs)')
  })
})

describe('markdown links', () => {
  it('only delegates OS-openable URLs to the system browser', () => {
    expect(isOpenableExternalUrl('https://openai.com/docs')).toBe(true)
    expect(isOpenableExternalUrl('http://localhost:1420')).toBe(true)
    expect(isOpenableExternalUrl('mailto:team@example.com')).toBe(true)
    expect(isOpenableExternalUrl('tel:+15551234567')).toBe(true)
    expect(isOpenableExternalUrl('/workspace/readme.md')).toBe(false)
    expect(isOpenableExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isOpenableExternalUrl('data:text/html,<b>x</b>')).toBe(false)
  })

  it('parses local file links with line and column locations', () => {
    expect(parseLocalFileReference('/repo/src/main.go:42')).toEqual({ path: '/repo/src/main.go', line: 42 })
    expect(parseLocalFileReference('src/main.go:42:7')).toEqual({ path: 'src/main.go', line: 42 })
    expect(parseLocalFileReference('file:///repo/My%20File.go#L9')).toEqual({ path: '/repo/My File.go', line: 9 })
    expect(parseLocalFileReference('../shared/types.ts')).toEqual({ path: '../shared/types.ts' })
  })

  it('treats bare single-segment names as local file references', () => {
    expect(parseLocalFileReference('README.md')).toEqual({ path: 'README.md' })
    expect(parseLocalFileReference('README')).toEqual({ path: 'README' })
    expect(parseLocalFileReference('bar')).toEqual({ path: 'bar' })
  })

  it('does not treat web URLs, command schemes, or punctuation-only labels as local files', () => {
    expect(parseLocalFileReference('https://example.com/file.go:42')).toBeNull()
    expect(parseLocalFileReference('javascript:alert(1)')).toBeNull()
    expect(parseLocalFileReference('.')).toBeNull()
    expect(parseLocalFileReference('..')).toBeNull()
    expect(parseLocalFileReference('#section')).toBeNull()
  })
})
