export interface RadarModelRow {
  group: 'hard' | 'simple' | 'reference'
  model: string
  effort: string
  iq: number
  price: number
  minutes: number
  bestIq: boolean
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
