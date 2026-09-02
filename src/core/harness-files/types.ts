import type { PluginProvider } from '../../extensions/types'

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
  configurationKey(provider?: PluginProvider): string
  list(cwd: string, provider?: PluginProvider): Promise<HarnessFileTree>
  read(cwd: string, path: string, provider?: PluginProvider): Promise<string>
  write(cwd: string, path: string, content: string, provider?: PluginProvider): Promise<void>
  createDirectory(cwd: string, path: string, provider?: PluginProvider): Promise<void>
  rename(cwd: string, path: string, nextPath: string, provider?: PluginProvider): Promise<void>
  remove(cwd: string, path: string, provider?: PluginProvider): Promise<void>
}
