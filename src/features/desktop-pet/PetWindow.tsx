import { Bell, GripHorizontal, PawPrint, X } from 'lucide-react'
import { useEffect, useState, type PointerEvent } from 'react'
import type { DesktopPetActivity, DesktopPetSnapshot } from '../../core/desktop-pet/types'
import { runtime } from '../../core/runtime/bridge'
import { PetSprite, usePetImage, useReducedMotion } from './PetSprite'
import { useIdleAnimation } from './useIdleAnimation'
import './desktopPet.css'

const labels: Record<DesktopPetActivity['status'], string> = {
  idle: '没有待关注事项', running: '会话正在运行', waiting: '会话需要你处理', failed: '任务出错', ready: '关注的会话已完成',
}

export default function PetWindow() {
  const [snapshot, setSnapshot] = useState<DesktopPetSnapshot>()
  const [loadError, setLoadError] = useState<string>()
  const [direction, setDirection] = useState<number>()
  const pet = snapshot?.pet
  const activity = snapshot?.activity
  const { url, error } = usePetImage(pet?.key)
  const reducedMotion = useReducedMotion()
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

  function look(event: PointerEvent<HTMLButtonElement>) {
    if (pet?.version !== 2) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - (rect.left + rect.width / 2)
    const y = event.clientY - (rect.top + rect.height / 2)
    setDirection(Math.hypot(x, y) < 12 ? undefined : (Math.round(Math.atan2(x, -y) * 8 / Math.PI) + 16) % 16)
  }

  return <main className="desktop-pet" data-status={activity?.status ?? 'idle'}>
    <button className="desktop-pet-character" type="button" aria-label="打开 Harness 助理"
      title={pet?.name ?? 'Harness 助理'} onPointerMove={look} onPointerLeave={() => setDirection(undefined)}
      onClick={() => handle(runtime.desktopPetOpen(true))}>
      {idleAnimation
        ? <img className="desktop-pet-idle-animation" src={idleAnimation} alt="" draggable={false} />
        : pet && url ? <PetSprite pet={pet} url={url} status={activity?.status} direction={direction} /> : <PawPrint size={38} />}
    </button>
    <div className="desktop-pet-controls">
      <button type="button" className="desktop-pet-grip" aria-label="拖动桌面宠物" title="拖动桌面宠物"
        onPointerDown={event => { if (event.button === 0) handle(runtime.startDesktopPetDragging()) }}><GripHorizontal size={17} /></button>
      <button type="button" className="desktop-pet-notice" data-unread={Boolean(activity?.count)} title={labels[activity?.status ?? 'idle']}
        aria-label={activity?.count ? `${labels[activity.status]}，${activity.count} 项` : '打开 Harness 通知'}
        onClick={() => handle(runtime.desktopPetOpen(false))}><Bell size={14} />{activity?.count ? <b>{Math.min(activity.count, 99)}</b> : null}</button>
      <button type="button" aria-label="隐藏桌面宠物" title="隐藏桌面宠物"
        onClick={() => handle(runtime.desktopPetVisibility(false))}><X size={14} /></button>
    </div>
    {(error || loadError) && <p className="desktop-pet-error" role="alert">{error ?? loadError}</p>}
  </main>
}
