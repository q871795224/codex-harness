import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDocWriteOutcome, ProjectMeta, ProjectDocSnapshot } from '../../features/project-doc/types'

const getAppState = vi.fn<(key: string) => Promise<string | null>>()
const setAppState = vi.fn<(key: string, value: string) => Promise<void>>()

vi.mock('../runtime/bridge', () => ({
  runtime: {
    projectDocCreate: vi.fn(async (projectId: string, name: string): Promise<ProjectMeta> => ({ projectId, name, currentSeq: 0, createdAt: 1, updatedAt: 1 })),
    projectDocList: vi.fn(async (): Promise<ProjectMeta[]> => []),
    projectDocGet: vi.fn(async (projectId: string): Promise<ProjectMeta> => ({ projectId, name: projectId, currentSeq: 0, createdAt: 1, updatedAt: 1 })),
    projectDocBindWorkspace: vi.fn(async () => undefined),
    projectDocWorkspaces: vi.fn(async (): Promise<string[]> => []),
    projectDocRead: vi.fn(async (projectId: string): Promise<ProjectDocSnapshot> => ({ projectId, currentSeq: 0, content: '', contentHash: 'h', consistent: true })),
    projectDocVersions: vi.fn(async () => []),
    projectDocWriteSection: vi.fn(async (): Promise<ProjectDocWriteOutcome> => ({ kind: 'applied', newSeq: 1, contentHash: 'h' })),
    getAppState: (key: string) => getAppState(key),
    setAppState: (key: string, value: string) => setAppState(key, value),
  },
}))

import { createProjectDocService } from './service'

describe('project-doc service thread bindings', () => {
  beforeEach(() => {
    getAppState.mockReset()
    setAppState.mockReset()
  })

  it('returns null when no binding stored', async () => {
    getAppState.mockResolvedValue(null)
    const service = createProjectDocService()
    expect(await service.threadProject('thread-1')).toBeNull()
  })

  it('binds and reads back a thread project', async () => {
    let stored: string | null = null
    getAppState.mockImplementation(async () => stored)
    setAppState.mockImplementation(async (_key, value) => { stored = value })
    const service = createProjectDocService()

    await service.bindThread('thread-1', 'demo')
    expect(JSON.parse(stored!)).toEqual({ 'thread-1': 'demo' })
    expect(await service.threadProject('thread-1')).toBe('demo')
  })

  it('unbinds a thread without touching others', async () => {
    let stored: string | null = JSON.stringify({ 'thread-1': 'demo', 'thread-2': 'other' })
    getAppState.mockImplementation(async () => stored)
    setAppState.mockImplementation(async (_key, value) => { stored = value })
    const service = createProjectDocService()

    await service.unbindThread('thread-1')
    expect(JSON.parse(stored!)).toEqual({ 'thread-2': 'other' })
  })

  it('ignores malformed stored state', async () => {
    getAppState.mockResolvedValue('not json')
    const service = createProjectDocService()
    expect(await service.threadProject('thread-1')).toBeNull()
  })
})
