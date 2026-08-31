export interface TerminalSessionInfo {
  sessionId: string
  shell: string
}

export type TerminalEvent =
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string }

export interface TerminalDiagnostic {
  level: 'info' | 'error'
  event: string
  durationMs?: number
  stage?: string
  status?: string
}

export interface TerminalService {
  create(cwd: string, cols: number, rows: number): Promise<TerminalSessionInfo>
  write(sessionId: string, data: string): Promise<void>
  resize(sessionId: string, cols: number, rows: number): Promise<void>
  close(sessionId: string): Promise<void>
  openIterm(cwd: string): Promise<void>
  onEvent(handler: (event: TerminalEvent) => void): Promise<() => void>
  recordDiagnostic(diagnostic: TerminalDiagnostic): Promise<void>
}
