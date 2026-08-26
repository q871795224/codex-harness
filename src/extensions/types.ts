/**
 * Deliberately small V2 seam. V1 registers no plugins and never loads external code.
 * Feature modules can later implement these contracts through a controlled registry.
 */
export interface HarnessFeatureTab {
  id: string
  label: string
  order?: number
}

export interface HarnessExtension {
  id: string
  version: string
  tabs?: HarnessFeatureTab[]
}
