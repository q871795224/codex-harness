export interface PetKey {
  source: 'builtin' | 'codex' | 'harness'
  directory: string
}

export interface DesktopPet {
  key: PetKey
  name: string
  description: string
  version: 0 | 1 | 2
  idleFrames: number
  idleAnimationDurations: number[]
}

export interface DesktopPetCatalog {
  hdReady: boolean
  scalePercent: number
  supported: boolean
  visible: boolean
  selected: PetKey | null
  pets: DesktopPet[]
}

export type DesktopPetStatus = 'idle' | 'running' | 'waiting' | 'failed' | 'ready'

export interface DesktopPetActivity {
  status: DesktopPetStatus
  count: number
  threadId: string | null
  notificationId: string | null
}

export interface DesktopPetSnapshot {
  hdMovieCount: number
  visible: boolean
  pet: DesktopPet | null
  activity: DesktopPetActivity
}

export interface DesktopPetOpenTarget {
  threadId: string | null
  notificationId: string | null
}

// Rectangle in fractions of the pet window, independent of screen DPI and pet scale.
export interface DesktopPetHitBounds {
  x: number
  y: number
  width: number
  height: number
}
