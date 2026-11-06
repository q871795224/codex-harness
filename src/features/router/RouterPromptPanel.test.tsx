// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RouterPromptPanel } from './RouterPromptPanel'
import { prepareRouterPreview, routingCandidates } from '../../core/workspace-router/service'
vi.mock('../../core/workspace-router/settings', () => ({ loadRouterSettings: vi.fn().mockResolvedValue({ model: 'test', descriptions: {} }) }))
vi.mock('../../core/workspace-router/service', () => ({ routingCandidates: vi.fn().mockResolvedValue([]), prepareRouterPreview: vi.fn() }))
const workspaces = [{ root: '/a', checkoutRoot: '/a', name: 'A' }] as never
beforeEach(() => {
  vi.mocked(prepareRouterPreview).mockReset().mockResolvedValue('actual rules\n{{用户输入}}')
})
afterEach(cleanup)
it('automatically displays a read-only prompt with an input placeholder', async () => {
  render(<RouterPromptPanel workspaces={workspaces} settingsVersion={0} />)
  await screen.findByLabelText('最终 Prompt')
  expect(screen.getByLabelText('最终 Prompt').textContent).toContain('actual rules')
  expect(screen.getByLabelText('最终 Prompt').textContent).toContain('{{用户输入}}')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(prepareRouterPreview).toHaveBeenCalledWith([expect.objectContaining({ text: '{{用户输入}}' })], [], expect.any(Object))
  expect(routingCandidates).toHaveBeenCalled()
})
it('reloads when settings or cached introductions change and skips inactive panels', async () => {
  const { rerender } = render(<RouterPromptPanel workspaces={workspaces} settingsVersion={0} active={false} />)
  expect(prepareRouterPreview).not.toHaveBeenCalled()
  rerender(<RouterPromptPanel workspaces={workspaces} settingsVersion={0} active />)
  await screen.findByLabelText('最终 Prompt')
  const before = vi.mocked(prepareRouterPreview).mock.calls.length
  rerender(<RouterPromptPanel workspaces={workspaces} settingsVersion={1} active />)
  await waitFor(() => expect(prepareRouterPreview).toHaveBeenCalledTimes(before + 1))
  await screen.findByLabelText('最终 Prompt')
  rerender(<RouterPromptPanel workspaces={workspaces} settingsVersion={1} active cacheVersion="updated" />)
  await waitFor(() => expect(prepareRouterPreview).toHaveBeenCalledTimes(before + 2))
})
