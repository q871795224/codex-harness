export interface PetKey {
  source: 'codex' | 'harness'
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
  supported: boolean
  visible: boolean
  selected: PetKey | null
  pets: DesktopPet[]
}

export interface DesktopPetActivity {
  status: 'idle' | 'running' | 'waiting' | 'failed' | 'ready'
  count: number
  threadId: string | null
  notificationId: string | null
}

export interface DesktopPetSnapshot {
  visible: boolean
  pet: DesktopPet | null
  activity: DesktopPetActivity
}

export interface DesktopPetOpenTarget {
  assistant: boolean
  threadId: string | null
  notificationId: string | null
}
