import { useEffect, useRef, useState } from 'react'
import type { DesktopPetStatus } from '../../core/desktop-pet/types'
import { runtime } from '../../core/runtime/bridge'

const IDLE_INTERVAL_MS = 60_000

export function DafeiyuVideo({ status, idleCount }: { status: DesktopPetStatus; idleCount: number }) {
  const [random, setRandom] = useState<number | null>(null)
  const [movie, setMovie] = useState<{ source: string; url: string }>()
  const [readyUrl, setReadyUrl] = useState<string>()
  const last = useRef<number | null>(null)
  const animation = status === 'idle' ? random : null
  const source = `${status}:${animation ?? 'base'}`

  useEffect(() => {
    if (status !== 'idle') {
      setRandom(null)
      return
    }
    if (random !== null) return
    const timer = window.setTimeout(() => {
      const previous = idleCount > 1 ? last.current : null
      const draw = Math.floor(Math.random() * (idleCount - (previous === null ? 0 : 1)))
      const next = previous !== null && draw >= previous ? draw + 1 : draw
      last.current = next
      setRandom(next)
    }, IDLE_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [status, idleCount, random])

  useEffect(() => {
    let cancelled = false
    let url: string | undefined
    void runtime.desktopPetMovie(status, animation).then(bytes => {
      if (cancelled) return
      url = URL.createObjectURL(new Blob([bytes], { type: 'video/quicktime' }))
      setMovie({ source, url })
    }).catch(() => {
      if (!cancelled && animation !== null) setRandom(null)
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [status, animation, source])

  if (!movie || movie.source !== source) return null
  return <video className="desktop-pet-video" data-ready={readyUrl === movie.url} key={movie.url}
    src={movie.url} autoPlay muted playsInline loop={animation === null} aria-hidden
    onLoadedData={() => setReadyUrl(movie.url)} onEnded={() => setRandom(null)}
    onError={() => { setReadyUrl(undefined); if (animation !== null) setRandom(null) }} />
}
