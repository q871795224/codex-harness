// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RouterPromptPanel } from './RouterPromptPanel'
import { prepareRouterPrompt, routingCandidates } from '../../core/workspace-router/service'
vi.mock('../../core/workspace-router/settings', () => ({ loadRouterSettings: vi.fn().mockResolvedValue({ model: 'test', descriptions: {} }) }))
vi.mock('../../core/workspace-router/service', () => ({ routingCandidates: vi.fn().mockResolvedValue([]), prepareRouterPrompt: vi.fn().mockResolvedValue({ developerInstructions: 'actual rules', input: [{ type: 'text', text: 'budgeted input' }], outputSchema: { type: 'object' } }) }))
afterEach(cleanup)
it('renders the prepared backend prompt and invalidates it when input or saved settings change', async () => {
  const { rerender } = render(<RouterPromptPanel workspaces={[{ root: '/a' }] as never} settingsVersion={0} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'DNS API request' } })
  fireEvent.click(screen.getByRole('button', { name: '按已保存设置生成' }))
  await screen.findByLabelText('最终 Prompt')
  expect(screen.getByLabelText('最终 Prompt').textContent).toContain('actual rules')
  expect(prepareRouterPrompt).toHaveBeenCalledWith([expect.objectContaining({ text: 'DNS API request' })], [], expect.any(Object))
  expect(routingCandidates).toHaveBeenCalled()
  rerender(<RouterPromptPanel workspaces={[{ root: '/a' }] as never} settingsVersion={1} />)
  expect(screen.queryByLabelText('最终 Prompt')).toBeNull()
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('DNS API request')
})
