// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspacePicker } from './WorkspacePicker'

afterEach(cleanup)

const workspaces = [
  { root: '/repo/Harness', checkoutRoot: '/repo/Harness', name: 'Codex Harness', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 },
  { root: '/repo/dns', checkoutRoot: '/repo/dns', name: '域名服务', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 },
  { root: '/repo/tools', checkoutRoot: '/repo/tools', name: 'Tools', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 },
]

function setup(overrides: Partial<Parameters<typeof WorkspacePicker>[0]> = {}) {
  const props = { value: '', workspaces, allowAutomatic: true, disabled: false, onChange: vi.fn(), onChooseDirectory: vi.fn(), ...overrides }
  const view = render(<WorkspacePicker {...props} />)
  const input = screen.getByRole('combobox', { name: '切换新会话工作区' }) as HTMLInputElement
  return { ...view, props, input }
}

function option(name: string) { return screen.getByRole('option', { name: new RegExp(name) }) }

describe('new session workspace search', () => {
  it('matches name substrings, paths and Chinese text while retaining unmatched options in gray', () => {
    const { input, props } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '  HARness ' } })
    expect(option('Codex Harness').getAttribute('aria-disabled')).toBe('false')
    expect(option('域名服务').getAttribute('aria-disabled')).toBe('true')
    expect(option('Tools').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(option('Tools'))
    expect(props.onChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '/repo/DNS' } })
    expect(option('域名服务').getAttribute('aria-disabled')).toBe('false')
    expect(option('Codex Harness').getAttribute('aria-disabled')).toBe('true')
    fireEvent.change(input, { target: { value: '域名' } })
    expect(option('域名服务').getAttribute('aria-disabled')).toBe('false')
    expect(props.onChange).not.toHaveBeenCalled()
    fireEvent.click(option('域名服务'))
    expect(props.onChange).toHaveBeenCalledWith('/repo/dns')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('uses arrows and Enter to select matches and skips unmatched workspaces', () => {
    const { input, props } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'dns' } })
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.textContent).toContain('域名服务')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.textContent).toBe('… 选择其他目录')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith('/repo/dns')
  })

  it('does not select on IME confirmation, but accepts Enter after composition', () => {
    const { input, props } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '域名' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(props.onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onChange).toHaveBeenCalledWith('/repo/dns')
  })

  it('shows no-match feedback, ignores Enter without a match and restores all choices on clearing', () => {
    const { input, props } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'missing' } })
    expect(screen.getByRole('status').textContent).toBe('没有匹配的工作区')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onChange).not.toHaveBeenCalled()
    expect(props.onChooseDirectory).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByRole('status')).toBeNull()
    for (const name of ['Codex Harness', '域名服务', 'Tools']) expect(option(name).getAttribute('aria-disabled')).toBe('false')
  })

  it('cancels on Escape or blur without changing the selection and can reopen by click', () => {
    const { input, props } = setup({ value: '/repo/Harness' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'dns' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('Codex Harness')
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(input)
    expect(input.value).toBe('')
    expect(option('Tools').getAttribute('aria-disabled')).toBe('false')
    fireEvent.blur(input, { relatedTarget: document.body })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.value).toBe('Codex Harness')
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('keeps automatic selection and the native directory picker available during a search', () => {
    const { input, props } = setup({ value: '/repo/Harness' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'missing' } })
    fireEvent.click(option('自动选择工作区'))
    expect(props.onChange).toHaveBeenCalledWith('')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'missing' } })
    fireEvent.click(option('选择其他目录'))
    expect(props.onChooseDirectory).toHaveBeenCalledTimes(1)
    expect(props.onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps automatic selection exclusive to Codex', () => {
    const { input } = setup({ value: '/repo/dns', allowAutomatic: false })
    expect(input.value).toBe('域名服务')
    fireEvent.focus(input)
    expect(screen.queryByRole('option', { name: '自动选择工作区' })).toBeNull()
    expect(screen.queryByRole('option', { name: '当前工作区' })).toBeNull()
  })

  it('closes and disables the control while the workspace is changing', () => {
    const { input, props, rerender } = setup()
    fireEvent.focus(input)
    rerender(<WorkspacePicker {...props} disabled />)
    expect(input.disabled).toBe(true)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(props.onChange).not.toHaveBeenCalled()
  })
})
