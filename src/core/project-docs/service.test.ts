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
    expect(await service.threadBinding('thread-1')).toBeNull()
  })

  it('binds as pending and reads back project + binding', async () => {
    let stored: string | null = null
    getAppState.mockImplementation(async () => stored)
    setAppState.mockImplementation(async (_key, value) => { stored = value })
    const service = createProjectDocService()

    await service.bindThread('thread-1', 'demo')
    expect(JSON.parse(stored!)).toEqual({ 'thread-1': { projectId: 'demo', phase: 'pending' } })
    expect(await service.threadProject('thread-1')).toBe('demo')
    expect(await service.threadBinding('thread-1')).toEqual({ projectId: 'demo', phase: 'pending' })
  })

  it('locks a pending binding on send', async () => {
    let stored: string | null = JSON.stringify({ 'thread-1': { projectId: 'demo', phase: 'pending' } })
    getAppState.mockImplementation(async () => stored)
    setAppState.mockImplementation(async (_key, value) => { stored = value })
    const service = createProjectDocService()

    await service.lockThreadBinding('thread-1')
    expect(JSON.parse(stored!)).toEqual({ 'thread-1': { projectId: 'demo', phase: 'locked' } })
    expect(await service.threadBinding('thread-1')).toEqual({ projectId: 'demo', phase: 'locked' })
  })

  it('lockThreadBinding is a no-op for missing or already-locked bindings', async () => {
    let stored: string | null = JSON.stringify({ 'thread-1': { projectId: 'demo', phase: 'locked' } })
    getAppState.mockImplementation(async () => stored)
    setAppState.mockImplementation(async (_key, value) => { stored = value })
    const service = createProjectDocService()

    await service.lockThreadBinding('thread-1')
    await service.lockThreadBinding('thread-unknown')
    expect(JSON.parse(stored!)).toEqual({ 'thread-1': { projectId: 'demo', phase: 'locked' } })
  })

  it('rebind replaces a pending binding', async () => {
    let stored: string | null = JSON.stringify({ 'thread-1': { projectId: 'old', phase: 'pending' } })
    getAppState.mockImplementation(async () => stored)
    setAppState.mockImplementation(async (_key, value) => { stored = value })
    const service = createProjectDocService()

    await service.bindThread('thread-1', 'new')
    expect(await service.threadBinding('thread-1')).toEqual({ projectId: 'new', phase: 'pending' })
  })

  it('treats legacy string bindings as locked', async () => {
    getAppState.mockResolvedValue(JSON.stringify({ 'thread-1': 'demo' }))
    const service = createProjectDocService()
    expect(await service.threadProject('thread-1')).toBe('demo')
    expect(await service.threadBinding('thread-1')).toEqual({ projectId: 'demo', phase: 'locked' })
  })

  it('unbinds a thread without touching others', async () => {
    let stored: string | null = JSON.stringify({
      'thread-1': { projectId: 'demo', phase: 'pending' },
      'thread-2': { projectId: 'other', phase: 'locked' },
    })
    getAppState.mockImplementation(async () => stored)
    setAppState.mockImplementation(async (_key, value) => { stored = value })
    const service = createProjectDocService()

    await service.unbindThread('thread-1')
    expect(JSON.parse(stored!)).toEqual({ 'thread-2': { projectId: 'other', phase: 'locked' } })
  })

  it('ignores malformed stored state', async () => {
    getAppState.mockResolvedValue('not json')
    const service = createProjectDocService()
    expect(await service.threadProject('thread-1')).toBeNull()
  })
})
