import { useEffect, useRef, useState } from 'react'
import type { DesktopPetHitBounds } from '../../core/desktop-pet/types'
import { placeBounds, visibleBounds } from './visibleBounds'

// Sample the displayed frame, including letterboxing, rather than the asset's canvas.
// The artwork keeps its original size so wide animations are never clipped.
export function usePetBounds(url?: string) {
  const artwork = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState<DesktopPetHitBounds | null>(null)
  useEffect(() => {
    const sheet = new Image()
    if (url) sheet.src = url
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return
    function measure() {
      const root = artwork.current
      if (!root || !context) return
      const rect = root.getBoundingClientRect()
      if (!rect.width || !rect.height || !window.innerWidth || !window.innerHeight) return
      const area = {
        x: rect.x / window.innerWidth, y: rect.y / window.innerHeight,
        width: rect.width / window.innerWidth, height: rect.height / window.innerHeight,
      }
      const video = root.querySelector<HTMLVideoElement>('video[data-ready="true"]')
      const image = root.querySelector<HTMLImageElement>('.desktop-pet-idle-animation')
      const sprite = root.querySelector<HTMLElement>('.desktop-pet-sprite')
      let source: CanvasImageSource, sx = 0, sy = 0, sw: number, sh: number
      if (video && video.readyState >= 2) {
        source = video; sw = video.videoWidth; sh = video.videoHeight
      } else if (image?.complete && image.naturalWidth) {
        source = image; sw = image.naturalWidth; sh = image.naturalHeight
      } else if (sprite && sheet.complete && sheet.naturalWidth) {
        source = sheet
        sw = sheet.naturalWidth / 8; sh = sheet.naturalHeight / Number(sprite.dataset.rows)
        sx = Number(sprite.dataset.col) * sw; sy = Number(sprite.dataset.row) * sh
      } else {
        const icon = root.querySelector('svg')?.getBoundingClientRect()
        if (icon) update({
          x: icon.x / window.innerWidth, y: icon.y / window.innerHeight,
          width: icon.width / window.innerWidth, height: icon.height / window.innerHeight,
        })
        return
      }
      if (!sw || !sh) return
      canvas.width = 192
      canvas.height = Math.max(1, Math.round(192 * rect.height / rect.width))
      const scale = Math.min(canvas.width / sw, canvas.height / sh)
      const width = sw * scale, height = sh * scale
      try {
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.drawImage(source, sx, sy, sw, sh, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
        const local = visibleBounds(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
        update(local && placeBounds(local, area))
      } catch {
        // Keep the previous bounds while a media frame is unavailable during a switch.
      }
    }
    function update(next: DesktopPetHitBounds | null) {
      setBounds(previous => {
        if (!previous || !next) return previous === next ? previous : next
        // Avoid changing the hit target for subpixel animation/compression noise.
        return (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(previous[key] - next[key]) < .005) ? previous : next
      })
    }
    measure()
    const timer = window.setInterval(measure, 100)
    return () => window.clearInterval(timer)
  }, [url])
  return { artwork, bounds }
}
