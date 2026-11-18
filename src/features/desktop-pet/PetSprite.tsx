import { useEffect, useState } from 'react'
import type { DesktopPet, DesktopPetActivity, PetKey } from '../../core/desktop-pet/types'
import { runtime } from '../../core/runtime/bridge'

const animations = {
  idle: { row: 0, timings: [280, 110, 110, 140, 140, 320] },
  running: { row: 7, timings: [120, 120, 120, 120, 120, 220] },
  waiting: { row: 6, timings: [150, 150, 150, 150, 150, 260] },
  failed: { row: 5, timings: [140, 140, 140, 140, 140, 140, 140, 240] },
  ready: { row: 8, timings: [150, 150, 150, 150, 150, 260] },
}

export function usePetImage(key?: PetKey) {
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState<string>()
  const directory = key?.directory
  const source = key?.source
  useEffect(() => {
    setError(undefined)
    setUrl(undefined)
    if (!directory || !source) return
    let disposed = false
    let objectUrl: string | undefined
    void runtime.desktopPetAsset({ directory, source }).then(bytes => {
      if (disposed) return
      const header = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength))
      const type = header[0] === 0x89 ? 'image/png' : 'image/webp'
      objectUrl = URL.createObjectURL(new Blob([bytes], { type }))
      setUrl(objectUrl)
    }).catch(reason => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [directory, source])
  return { url, error }
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return reduced
}

export function petFrame(pet: Pick<DesktopPet, 'version' | 'idleFrames'>, status: DesktopPetActivity['status'], frame: number, direction?: number) {
  if (pet.version === 0) return { row: Math.floor(frame / 8), col: frame % 8, rows: Math.ceil(pet.idleFrames / 8) }
  const rows = pet.version === 2 ? 11 : 9
  if (pet.version === 2 && status === 'idle' && direction !== undefined) {
    return { row: 9 + Math.floor(direction / 8), col: direction % 8, rows }
  }
  return { row: animations[status].row, col: frame, rows }
}

export function PetSprite({ pet, url, status = 'idle', direction }: { pet: DesktopPet; url: string; status?: DesktopPetActivity['status']; direction?: number }) {
  const [step, setStep] = useState(0)
  const reduced = useReducedMotion()
  const custom = pet.version === 0
  const timings = animations[status].timings
  const count = custom ? pet.idleFrames : timings.length
  const frame = reduced ? 0 : step % count
  const straight = reduced ? 'idle' : status
  useEffect(() => setStep(0), [pet.key.directory, pet.key.source, status])
  useEffect(() => {
    if (reduced || count <= 1 || (status === 'idle' && direction !== undefined && pet.version === 2)) return
    const timeout = window.setTimeout(() => setStep(current => current + 1), custom ? 150 : timings[frame])
    return () => window.clearTimeout(timeout)
  }, [count, custom, direction, frame, pet.version, reduced, status, timings])
  const { row, col, rows } = petFrame(pet, straight, frame, reduced ? undefined : direction)
  return <span className="desktop-pet-sprite" aria-hidden="true" style={{
    backgroundImage: `url("${url}")`, backgroundSize: `800% ${rows * 100}%`,
    backgroundPosition: `${col * 100 / 7}% ${rows > 1 ? row * 100 / (rows - 1) : 0}%`,
  }} />
}
