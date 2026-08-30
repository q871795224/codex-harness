export type HarnessFileNodeKind = 'file' | 'directory'
export type HarnessFileNodeSource = 'global' | 'project' | 'harness'
export type HarnessInstructionStatus = 'active' | 'overridden' | 'empty' | 'truncated' | 'excluded'

export interface HarnessInstructionConfig {
  fallbackFilenames: string[]
  maxBytes: number
}

export interface HarnessFileNode {
  path: string
  name: string
  kind: HarnessFileNodeKind
  source: HarnessFileNodeSource
  exists: boolean
  instructionStatus: HarnessInstructionStatus | null
  children: HarnessFileNode[]
}

export interface HarnessFileTree {
  cwd: string
  projectRoot: string | null
  roots: HarnessFileNode[]
}

export interface HarnessFilesService {
  configurationKey(): string
  list(cwd: string): Promise<HarnessFileTree>
  read(cwd: string, path: string): Promise<string>
  write(cwd: string, path: string, content: string): Promise<void>
  createDirectory(cwd: string, path: string): Promise<void>
  rename(cwd: string, path: string, nextPath: string): Promise<void>
  remove(cwd: string, path: string): Promise<void>
}
