import type { CSSProperties } from 'react'
import type { DesktopPetLayout, PetKey } from '../../core/desktop-pet/types'
import layout from '../../../src-tauri/pets/dafeiyu/layout.json'

export function petLayout(key: PetKey | undefined, hd: boolean): DesktopPetLayout {
  return key?.source === 'builtin' && key.directory === 'dafeiyu'
    ? hd ? 'dafeiyu-video' : 'dafeiyu-still'
    : 'original'
}

// Measured against the bundled still and the full idle video, then fixed in layout.json.
// Nothing in this layout depends on the current frame, status or pointer position.
export function dafeiyuArtwork(video: boolean): CSSProperties {
  const crop = video ? layout.video : layout.still
  return {
    left: `${crop.left / crop.width * 100}%`, top: `${crop.top / crop.height * 100}%`,
    width: `${layout.artworkWidth / crop.width * 100}%`, height: `${layout.artworkHeight / crop.height * 100}%`,
  }
}

export function dafeiyuLayer(video: boolean): CSSProperties {
  const crop = video ? layout.video : layout.still
  const ratio = crop.width / crop.height
  return { width: `min(100vw, ${ratio * 100}vh)`, height: `min(100vh, ${100 / ratio}vw)` }
}
