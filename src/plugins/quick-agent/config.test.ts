import { describe, expect, it } from 'vitest'
import { migrateQuickAgentInstances, readQuickAgentConfig, settingsForMode, type QuickAgentJob } from './config'
import type { PluginInstanceRecord } from '../../extensions/types'

const job = (overrides: Partial<QuickAgentJob> = {}): QuickAgentJob => ({
  id: 'job-1',
  name: '发布',
  prompt: '发布当前项目',
  model: 'gpt-5.6-luna',
  effort: 'max',
  mode: 'yolo',
  workspaceAccess: 'shared-write',
  ...overrides,
})

describe('quick agent config', () => {
  it('drops invalid and duplicate job ids', () => {
    const config = readQuickAgentConfig({ jobs: [job(), job({ name: '重复' }), { id: '', name: '无效' }] })
    expect(config.jobs).toEqual([job()])
  })

  it('defaults legacy jobs to YOLO with shared workspace access', () => {
    const value = { ...job() } as Record<string, unknown>
    delete value.mode
    delete value.workspaceAccess
    expect(readQuickAgentConfig({ jobs: [value] }).jobs[0].mode).toBe('yolo')
    expect(readQuickAgentConfig({ jobs: [value] }).jobs[0].workspaceAccess).toBe('shared-write')
  })

  it('keeps the first job available for one-job plugin instances', () => {
    expect(readQuickAgentConfig({ jobs: [job(), job({ id: 'job-2', name: '检查' })] }).jobs[0]).toEqual(job())
  })

  it('splits legacy multi-job config into independently scoped instances', () => {
    const instance: PluginInstanceRecord = {
      instanceId: 'quick-agent',
      pluginId: 'builtin.quick-agent',
      scope: { kind: 'workspace', workspaceRoot: '/repo' },
      enabled: true,
      config: { jobs: [job(), job({ id: 'job-2', name: '检查' })] },
      createdAt: 10,
      updatedAt: 20,
    }
    const migrated = migrateQuickAgentInstances([instance])
    expect(migrated).toHaveLength(2)
    expect(migrated.map((item) => item.scope)).toEqual([instance.scope, instance.scope])
    expect(migrated.map((item) => readQuickAgentConfig(item.config).jobs[0].id)).toEqual(['job-1', 'job-2'])
    expect(migrateQuickAgentInstances(migrated)).toEqual(migrated)
  })

  it('maps each run mode to isolated thread settings', () => {
    expect(settingsForMode(job())).toMatchObject({ approvalPolicy: 'never', sandboxMode: 'danger-full-access' })
    expect(settingsForMode(job({ mode: 'auto-review' }))).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })
    expect(settingsForMode(job({ mode: 'manual' }))).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user' })
    expect(settingsForMode(job({ workspaceAccess: 'read-only' }))).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'on-request' })
  })
})
