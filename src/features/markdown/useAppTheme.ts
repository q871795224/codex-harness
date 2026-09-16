import { useEffect, useState } from 'react'

export type AppTheme = 'light' | 'dark'

function readAppTheme(): AppTheme {
  return document.querySelector('.app-shell')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export function useAppTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(readAppTheme)
  useEffect(() => {
    const shell = document.querySelector('.app-shell')
    if (!shell) return
    const observer = new MutationObserver(() => setTheme(readAppTheme()))
    observer.observe(shell, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}
