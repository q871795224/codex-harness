import { PawPrint } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { DesktopPetActivity, DesktopPetSnapshot } from '../../core/desktop-pet/types'
import { runtime } from '../../core/runtime/bridge'
import { PetSprite, usePetImage, useReducedMotion } from './PetSprite'
import { useIdleAnimation } from './useIdleAnimation'
import { DafeiyuVideo } from './DafeiyuVideo'
import { usePetBounds } from './usePetBounds'
import { dafeiyuArtwork, dafeiyuLayer, petLayout } from './dafeiyuLayout'
import './desktopPet.css'

const labels: Record<DesktopPetActivity['status'], string> = {
  idle: '没有待关注事项', running: '会话正在运行', waiting: '会话需要你处理', failed: '任务出错', ready: '关注的会话已完成',
}

export default function PetWindow() {
  const [snapshot, setSnapshot] = useState<DesktopPetSnapshot>()
  const [loadError, setLoadError] = useState<string>()
  const [direction, setDirection] = useState<number>()
  const press = useRef<{ id: number; x: number; y: number; timer: number }>()
  const suppressClick = useRef(false)
  function cancelPress() {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = undefined
  }
  useEffect(() => cancelPress, [])
  const pet = snapshot?.pet
  const activity = snapshot?.activity
  const { url, error } = usePetImage(pet?.key)
  const hdCount = snapshot?.hdMovieCount ?? 0
  const reducedMotion = useReducedMotion()
  const hd = hdCount > 0 && !reducedMotion
  const layout = petLayout(pet?.key, hd)
  const dafeiyu = layout !== 'original'
  const { artwork, bounds } = usePetBounds(url, Boolean(pet) && !dafeiyu)
  const idleAnimation = useIdleAnimation(pet, Boolean(
    snapshot?.visible && activity?.status === 'idle' && url && !reducedMotion,
  ))
  useEffect(() => {
    let disposed = false
    let remove: (() => void) | undefined
    let revision = 0
    const refresh = () => {
      const expected = ++revision
      void runtime.desktopPetSnapshot().then(next => {
        if (!disposed && revision === expected) { setSnapshot(next); setLoadError(undefined) }
      }).catch(reason => {
        if (!disposed && revision === expected) setLoadError(String(reason))
      })
    }
    void runtime.listenDesktopPetChanges(refresh).then(unlisten => {
      if (disposed) unlisten()
      else { remove = unlisten; refresh() }
    }).catch(reason => { if (!disposed) setLoadError(String(reason)) })
    return () => { disposed = true; remove?.() }
  }, [])

  const handle = (action: Promise<unknown>) => { void action.catch(reason => setLoadError(String(reason))) }

  useEffect(() => {
    if (snapshot && !dafeiyu) handle(runtime.desktopPetSetHitBounds(bounds))
  }, [bounds, dafeiyu, Boolean(snapshot)])
  useEffect(() => {
    if (snapshot) handle(runtime.desktopPetSetLayout(layout))
  }, [layout, Boolean(snapshot)])

  function beginPress(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || press.current) return
    suppressClick.current = false
    const { pointerId: id, clientX: x, clientY: y } = event
    event.currentTarget.setPointerCapture?.(id)
    const timer = window.setTimeout(() => {
      if (press.current?.id !== id) return
      suppressClick.current = true
      handle(runtime.desktopPetDrag())
    }, 320)
    press.current = { id, x, y, timer }
  }

  function movePointer(event: PointerEvent<HTMLButtonElement>) {
    const holding = press.current
    if (holding?.id === event.pointerId && !suppressClick.current && Math.hypot(event.clientX - holding.x, event.clientY - holding.y) > 8) {
      suppressClick.current = true
      cancelPress()
    }
    if (pet?.version !== 2) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - (rect.left + rect.width / 2)
    const y = event.clientY - (rect.top + rect.height / 2)
    setDirection(Math.hypot(x, y) < 12 ? undefined : (Math.round(Math.atan2(x, -y) * 8 / Math.PI) + 16) % 16)
  }

  function finishPress(event: PointerEvent<HTMLButtonElement>) {
    if (press.current?.id === event.pointerId) cancelPress()
  }

  const still = idleAnimation
    ? <img className="desktop-pet-idle-animation" src={idleAnimation} alt="" draggable={false} />
    : pet && url ? <PetSprite pet={pet} url={url} status={activity?.status} direction={direction} /> : <PawPrint size={38} />
  return <main className="desktop-pet" data-status={activity?.status ?? 'idle'} data-layout={layout}>
    {dafeiyu ? <>
      <div className="desktop-pet-dafeiyu-layer" style={dafeiyuLayer(false)}>
        <div className="desktop-pet-artwork" style={dafeiyuArtwork(false)}>{still}</div>
      </div>
      {hd && snapshot?.visible && <div className="desktop-pet-dafeiyu-layer desktop-pet-movie-layer" style={dafeiyuLayer(true)}>
        <div className="desktop-pet-artwork" style={dafeiyuArtwork(true)}><DafeiyuVideo status={activity?.status ?? 'idle'} idleCount={hdCount} /></div>
      </div>}
    </> :
    <div className="desktop-pet-artwork" ref={artwork}>
      {still}
    </div>}
    <button className="desktop-pet-character" type="button" aria-label="打开 Harness 助理" style={dafeiyu ? { inset: 0, width: '100%', height: '100%' } : bounds ? {
      left: `${bounds.x * 100}%`, top: `${bounds.y * 100}%`,
      width: `${bounds.width * 100}%`, height: `${bounds.height * 100}%`,
    } : { visibility: 'hidden' }}
      title={pet?.name ?? 'Harness 助理'} onPointerDown={beginPress} onPointerMove={movePointer}
      onPointerUp={finishPress} onPointerCancel={finishPress} onLostPointerCapture={finishPress} onPointerLeave={() => setDirection(undefined)}
      onClick={event => { if (event.detail === 0 || !suppressClick.current) handle(runtime.desktopPetOpen()) }}
      onContextMenu={event => { event.preventDefault(); cancelPress(); handle(runtime.desktopPetMenu()) }}>
      {activity?.count ? <span className="desktop-pet-notice" role="status" aria-label={`${labels[activity.status]}，${activity.count} 项`}>{Math.min(activity.count, 99)}</span> : null}
    </button>
    {(error || loadError) && <p className="desktop-pet-error" role="alert">{error ?? loadError}</p>}
  </main>
}
