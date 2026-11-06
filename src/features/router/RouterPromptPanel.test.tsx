// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RouterPromptPanel } from './RouterPromptPanel'
import { prepareRouterPrompt, routingCandidates } from '../../core/workspace-router/service'
vi.mock('../../core/workspace-router/settings', () => ({ loadRouterSettings: vi.fn().mockResolvedValue({ model: 'test', descriptions: {} }) }))
vi.mock('../../core/workspace-router/service', () => ({ routingCandidates: vi.fn().mockResolvedValue([]), prepareRouterPrompt: vi.fn() }))
const workspaces = [{ root: '/a', checkoutRoot: '/a', name: 'A' }] as never
beforeEach(() => {
  vi.mocked(prepareRouterPrompt).mockReset().mockResolvedValue({ developerInstructions: 'actual rules', input: [{ type: 'text', text: '{{用户输入}}', text_elements: [] }], outputSchema: { type: 'object' } } as never)
})
afterEach(cleanup)
it('automatically displays a read-only prompt with an input placeholder', async () => {
  render(<RouterPromptPanel workspaces={workspaces} settingsVersion={0} />)
  await screen.findByLabelText('最终 Prompt')
  expect(screen.getByLabelText('最终 Prompt').textContent).toContain('actual rules')
  expect(screen.getByLabelText('最终 Prompt').textContent).toContain('{{用户输入}}')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(prepareRouterPrompt).toHaveBeenCalledWith([expect.objectContaining({ text: '{{用户输入}}' })], [], expect.any(Object))
  expect(routingCandidates).toHaveBeenCalled()
})
it('reloads when settings or cached introductions change and skips inactive panels', async () => {
  const { rerender } = render(<RouterPromptPanel workspaces={workspaces} settingsVersion={0} active={false} />)
  expect(prepareRouterPrompt).not.toHaveBeenCalled()
  rerender(<RouterPromptPanel workspaces={workspaces} settingsVersion={0} active />)
  await screen.findByLabelText('最终 Prompt')
  const before = vi.mocked(prepareRouterPrompt).mock.calls.length
  rerender(<RouterPromptPanel workspaces={workspaces} settingsVersion={1} active />)
  await waitFor(() => expect(prepareRouterPrompt).toHaveBeenCalledTimes(before + 1))
  await screen.findByLabelText('最终 Prompt')
  rerender(<RouterPromptPanel workspaces={workspaces} settingsVersion={1} active cacheVersion="updated" />)
  await waitFor(() => expect(prepareRouterPrompt).toHaveBeenCalledTimes(before + 2))
})
