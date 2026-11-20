import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopPetStatus } from '../../core/desktop-pet/types'
import { runtime } from '../../core/runtime/bridge'
import { nextDafeiyuClip, type DafeiyuPhase } from './dafeiyuPlaylist'

interface Movie { source: string; status: DesktopPetStatus; url: string }

export function DafeiyuVideo({ status, idleCount }: { status: DesktopPetStatus; idleCount: number }) {
  const [random, setRandom] = useState<number | null>(null)
  const [phase, setPhase] = useState<DafeiyuPhase>('bridge')
  const [movie, setMovie] = useState<Movie>()
  const [displayed, setDisplayed] = useState<Movie>()
  const [failedSource, setFailedSource] = useState<string>()
  const lastAction = useRef<number | null>(null)
  const lastBridge = useRef<number | null>(null)
  const urls = useRef(new Set<string>())
  const animation = status === 'idle' ? random : null
  const source = `${status}:${animation ?? 'base'}`

  const advance = useCallback(() => {
    if (status !== 'idle' || idleCount <= 0) return
    const nextPhase = phase === 'bridge' ? 'action' : 'bridge'
    const previous = nextPhase === 'action' ? lastAction : lastBridge
    const next = nextDafeiyuClip(idleCount, nextPhase, previous.current)
    previous.current = next
    setPhase(nextPhase)
    setRandom(next)
  }, [status, idleCount, phase])

  useEffect(() => {
    if (status !== 'idle') {
      setRandom(null)
      setPhase('bridge')
      lastBridge.current = null
    }
  }, [status])
  useEffect(() => {
    if (failedSource !== source || status !== 'idle') return
    // Skip unreadable clips without spinning on a broken media package.
    const timer = window.setTimeout(advance, 2000)
    return () => window.clearTimeout(timer)
  }, [advance, failedSource, source, status])

  useEffect(() => {
    let cancelled = false
    setFailedSource(undefined)
    void runtime.desktopPetMovie(status, animation).then(bytes => {
      if (cancelled) return
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/quicktime' }))
      urls.current.add(url)
      setMovie({ source, status, url })
    }).catch(() => {
      if (!cancelled) setFailedSource(source)
    })
    return () => { cancelled = true }
  }, [status, animation, source])

  useEffect(() => {
    for (const url of urls.current) if (url !== movie?.url && url !== displayed?.url) {
      URL.revokeObjectURL(url)
      urls.current.delete(url)
    }
  }, [movie, displayed])
  useEffect(() => () => { urls.current.forEach(url => URL.revokeObjectURL(url)) }, [])

  // Retain the last frame until the next clip can render. Activity changes bypass it.
  const clips = [displayed, movie].filter((clip, index, list): clip is Movie =>
    Boolean(clip && clip.status === status && list.findIndex(item => item?.url === clip.url) === index))
  return <>{clips.map(clip => <video className="desktop-pet-video" data-ready={displayed?.url === clip.url} key={clip.url}
    src={clip.url} autoPlay muted playsInline loop={status !== 'idle' || idleCount <= 0} aria-hidden
    onLoadedData={() => { if (clip.source === source) setDisplayed(clip) }}
    onEnded={() => { if (clip.source === source && failedSource !== source) advance() }}
    onError={() => { if (clip.source === source) { setDisplayed(undefined); setFailedSource(source) } }} />)}</>
}
