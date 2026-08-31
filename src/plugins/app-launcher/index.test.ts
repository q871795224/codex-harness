import { describe, expect, it } from 'vitest'
import type { AppLauncherService } from '../../core/app-launcher/types'
import { PluginHost } from '../../core/plugins/runtime'
import { appLauncherDefaultInstance, appLauncherPlugin } from './index'

describe('app launcher plugin', () => {
  it('registers a header action backed by the restricted launcher service', async () => {
    const service: AppLauncherService = { open: async () => undefined }
    const host = new PluginHost([appLauncherPlugin], {
      storage: () => ({ async get<T>() { return null as T | null }, async set() {} }),
      services: { 'harness.appLauncher': service },
    })

    await host.syncInstances([appLauncherDefaultInstance])

    const actions = host.resolvedThreadHeaderActions({ threadId: 'thread-1', threadCwd: '/repo-worktree', workspaceRoot: '/repo' })
    expect(actions).toHaveLength(1)
    expect(actions[0].contribution.id).toBe('open-in-goland')
    expect(appLauncherPlugin.manifest.permissions).toContain('process:open-application')
  })
})
