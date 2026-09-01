import { describe, expect, it } from 'vitest'
import { displayCommand } from './commandDisplay'

describe('displayCommand', () => {
  it('hides the common login shell wrapper', () => {
    expect(displayCommand('/bin/zsh -lc "git status --short"')).toBe('git status --short')
    expect(displayCommand('/bin/bash -l -c "pnpm test"')).toBe('pnpm test')
  })

  it('unescapes a quoted command without changing its arguments', () => {
    expect(displayCommand('/bin/zsh -lc "printf \\"hello\\""')).toBe('printf "hello"')
  })

  it('keeps commands that are not shell wrappers unchanged', () => {
    expect(displayCommand('git status --short')).toBe('git status --short')
    expect(displayCommand('/bin/zsh -lc')).toBe('/bin/zsh -lc')
  })
})
