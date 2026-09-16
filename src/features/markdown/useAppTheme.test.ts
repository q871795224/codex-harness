// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { useAppTheme } from './useAppTheme'

afterEach(() => {
  document.body.innerHTML = ''
})

it('defaults to light when no app shell exists', () => {
  const { result } = renderHook(() => useAppTheme())
  expect(result.current).toBe('light')
})

it('reads the current theme from the app shell', () => {
  const shell = document.createElement('div')
  shell.className = 'app-shell'
  shell.setAttribute('data-theme', 'dark')
  document.body.appendChild(shell)

  const { result } = renderHook(() => useAppTheme())
  expect(result.current).toBe('dark')
})

it('follows theme changes on the app shell', async () => {
  const shell = document.createElement('div')
  shell.className = 'app-shell'
  shell.setAttribute('data-theme', 'light')
  document.body.appendChild(shell)

  const { result } = renderHook(() => useAppTheme())
  expect(result.current).toBe('light')

  shell.setAttribute('data-theme', 'dark')
  await waitFor(() => expect(result.current).toBe('dark'))
})
