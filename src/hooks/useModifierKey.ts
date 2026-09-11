import { useEffect, useState } from 'react'

export function useModifierKey(key: 'Meta' | 'Control'): boolean {
  const [pressed, setPressed] = useState(false)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === key) setPressed(true)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === key) setPressed(false)
    }
    const handleBlur = () => setPressed(false)

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [key])

  return pressed
}
