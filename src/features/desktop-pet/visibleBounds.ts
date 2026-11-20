import type { DesktopPetHitBounds } from '../../core/desktop-pet/types'

// Ignore nearly transparent compression noise and soft shadows around the character.
export function visibleBounds(data: Uint8ClampedArray, width: number, height: number): DesktopPetHitBounds | null {
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= 16) continue
      left = Math.min(left, x); top = Math.min(top, y)
      right = Math.max(right, x); bottom = Math.max(bottom, y)
    }
  }
  return right < left ? null : {
    x: left / width, y: top / height,
    width: (right + 1 - left) / width, height: (bottom + 1 - top) / height,
  }
}

export function placeBounds(bounds: DesktopPetHitBounds, artwork: DesktopPetHitBounds): DesktopPetHitBounds {
  return {
    x: artwork.x + bounds.x * artwork.width,
    y: artwork.y + bounds.y * artwork.height,
    width: bounds.width * artwork.width,
    height: bounds.height * artwork.height,
  }
}
