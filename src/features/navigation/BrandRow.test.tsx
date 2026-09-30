// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BrandRow } from './BrandRow'
afterEach(cleanup)
it.each(['conversation', 'team'] as const)('switches from %s through both the brand icon and name', (view) => {
  const onSwitchView = vi.fn()
  render(<BrandRow view={view} onSwitchView={onSwitchView} />)
  const button = screen.getByRole('button', { name: view === 'conversation' ? '切换到团队视图' : '切换到会话视图' })
  fireEvent.click(button.querySelector('img')!)
  fireEvent.click(screen.getByText('HARNESS'))
  expect(onSwitchView).toHaveBeenCalledTimes(2)
  expect(button.getAttribute('title')).toContain(view === 'conversation' ? '会话视图' : '团队视图')
})
