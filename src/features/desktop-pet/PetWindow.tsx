import { PawPrint } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { DesktopPetActivity, DesktopPetSnapshot } from '../../core/desktop-pet/types'
import { runtime } from '../../core/runtime/bridge'
import { PetSprite, usePetImage } from './PetSprite'
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

  return <main className="desktop-pet" data-status={activity?.status ?? 'idle'}>
    <button className="desktop-pet-character" type="button" aria-label="打开 Harness 助理"
      title={pet?.name ?? 'Harness 助理'} onPointerDown={beginPress} onPointerMove={movePointer}
      onPointerUp={finishPress} onPointerCancel={finishPress} onLostPointerCapture={finishPress} onPointerLeave={() => setDirection(undefined)}
      onClick={event => { if (event.detail === 0 || !suppressClick.current) handle(runtime.desktopPetOpen()) }}
      onContextMenu={event => { event.preventDefault(); cancelPress(); handle(runtime.desktopPetMenu()) }}>
      {pet && url ? <PetSprite pet={pet} url={url} status={activity?.status} direction={direction} /> : <PawPrint size={38} />}
      {activity?.count ? <span className="desktop-pet-notice" role="status" aria-label={`${labels[activity.status]}，${activity.count} 项`}>{Math.min(activity.count, 99)}</span> : null}
    </button>
    {(error || loadError) && <p className="desktop-pet-error" role="alert">{error ?? loadError}</p>}
  </main>
}
