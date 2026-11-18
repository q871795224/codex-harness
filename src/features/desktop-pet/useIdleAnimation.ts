import { useEffect, useRef, useState } from 'react'
import type { DesktopPet } from '../../core/desktop-pet/types'
import { runtime } from '../../core/runtime/bridge'

const IDLE_INTERVAL_MS = 60_000

export function useIdleAnimation(pet: DesktopPet | null | undefined, enabled: boolean): string | undefined {
  const source = pet?.key.source
  const directory = pet?.key.directory
  const count = pet?.idleAnimationDurations.length ?? 0
  const durations = useRef(pet?.idleAnimationDurations)
  durations.current = pet?.idleAnimationDurations
  const previous = useRef<{ directory: string; source: typeof source; index: number }>()
  const [animation, setAnimation] = useState<{ directory: string; source: typeof source; url: string }>()

  useEffect(() => {
    setAnimation(undefined)
    if (!enabled || !source || !directory || count === 0) return

    let disposed = false
    let timeout: number
    let url: string | undefined

    function wait() {
      timeout = window.setTimeout(play, IDLE_INTERVAL_MS)
    }

    async function play() {
      if (!source || !directory) return
      const prior = previous.current
      const skip = count > 1 && prior?.source === source && prior.directory === directory ? prior.index : -1
      const choice = Math.floor(Math.random() * (skip < 0 ? count : count - 1))
      const index = skip >= 0 && choice >= skip ? choice + 1 : choice
      const duration = durations.current?.[index]
      if (duration === undefined) { wait(); return }
      try {
        const bytes = await runtime.desktopPetAsset({ source, directory }, index)
        if (disposed) return
        url = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }))
        previous.current = { source, directory, index }
        setAnimation({ source, directory, url })
        timeout = window.setTimeout(() => {
          if (url) URL.revokeObjectURL(url)
          url = undefined
          setAnimation(undefined)
          wait()
        }, duration)
      } catch {
        if (!disposed) wait()
      }
    }

    wait()
    return () => {
      disposed = true
      window.clearTimeout(timeout)
      if (url) URL.revokeObjectURL(url)
    }
  }, [enabled, source, directory, count])

  return enabled && animation && animation.source === source && animation.directory === directory ? animation.url : undefined
}
