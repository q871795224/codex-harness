export interface RadarModelRow {
  group: 'hard' | 'simple' | 'reference' | 'agi'
  model: string
  effort: string
  score: number | null
  coverage: number
  price: number | null
  minutes: number | null
  bestScore: boolean
  bestPrice: boolean
  bestMinutes: boolean
  automatic: boolean
  defaultCursor: boolean
}

export interface RadarModelTable {
  rows: RadarModelRow[]
  fetchedAt: number
}

export interface CodexRadarService {
  modelTable(): Promise<RadarModelTable>
}
