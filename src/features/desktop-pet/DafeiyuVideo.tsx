import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopPetStatus } from '../../core/desktop-pet/types'
import { runtime } from '../../core/runtime/bridge'
import { nextDafeiyuClip, type DafeiyuPhase } from './dafeiyuPlaylist'

interface Movie { source: string; url: string }

export function DafeiyuVideo({ status, idleCount }: { status: DesktopPetStatus; idleCount: number }) {
  // A new activity interrupts playback once; repeated snapshots keep the playlist moving.
  return <DafeiyuPlayback key={status} status={status} idleCount={idleCount} />
}

function DafeiyuPlayback({ status, idleCount }: { status: DesktopPetStatus; idleCount: number }) {
  const [random, setRandom] = useState<number | null>(null)
  const [phase, setPhase] = useState<DafeiyuPhase | 'status'>(status === 'idle' ? 'bridge' : 'status')
  const [movie, setMovie] = useState<Movie>()
  const [displayed, setDisplayed] = useState<Movie>()
  const [failedSource, setFailedSource] = useState<string>()
  const lastAction = useRef<number | null>(null)
  const lastBridge = useRef<number | null>(null)
  const urls = useRef(new Set<string>())
  const movieStatus = phase === 'status' ? status : 'idle'
  const animation = phase === 'status' ? null : random
  const source = `${movieStatus}:${animation ?? 'base'}`

  const advance = useCallback(() => {
    if (idleCount <= 0) return
    if (phase === 'status') {
      setPhase('bridge')
      return
    }
    const nextPhase = phase === 'bridge' ? 'action' : 'bridge'
    const previous = nextPhase === 'action' ? lastAction : lastBridge
    const next = nextDafeiyuClip(idleCount, nextPhase, previous.current)
    previous.current = next
    setPhase(nextPhase)
    setRandom(next)
  }, [idleCount, phase])

  useEffect(() => {
    if (failedSource !== source) return
    // Skip unreadable clips without spinning on a broken media package.
    const timer = window.setTimeout(advance, 2000)
    return () => window.clearTimeout(timer)
  }, [advance, failedSource, source])

  useEffect(() => {
    let cancelled = false
    setFailedSource(undefined)
    void runtime.desktopPetMovie(movieStatus, animation).then(bytes => {
      if (cancelled) return
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/quicktime' }))
      urls.current.add(url)
      setMovie({ source, url })
    }).catch(() => {
      if (!cancelled) setFailedSource(source)
    })
    return () => { cancelled = true }
  }, [movieStatus, animation, source])

  useEffect(() => {
    for (const url of urls.current) if (url !== movie?.url && url !== displayed?.url) {
      URL.revokeObjectURL(url)
      urls.current.delete(url)
    }
  }, [movie, displayed])
  useEffect(() => () => { urls.current.forEach(url => URL.revokeObjectURL(url)) }, [])

  // Retain the last frame until the next clip can render, including after a status hint.
  const clips = [displayed, movie].filter((clip, index, list): clip is Movie =>
    Boolean(clip && list.findIndex(item => item?.url === clip.url) === index))
  return <>{clips.map(clip => <video className="desktop-pet-video" data-ready={displayed?.url === clip.url} key={clip.url}
    src={clip.url} autoPlay muted playsInline loop={idleCount <= 0} aria-hidden
    onLoadedData={() => { if (clip.source === source) setDisplayed(clip) }}
    onEnded={() => { if (clip.source === source && failedSource !== source) advance() }}
    onError={() => { if (clip.source === source) { setDisplayed(undefined); setFailedSource(source) } }} />)}</>
}
