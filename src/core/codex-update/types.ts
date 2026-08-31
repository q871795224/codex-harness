export interface CodexUpdateStatus {
  currentVersion: string | null
  appServerVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  skipped: boolean
  lastCheckedAt: number | null
  checkError: string | null
}
