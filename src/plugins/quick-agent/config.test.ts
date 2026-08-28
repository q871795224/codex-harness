import { describe, expect, it } from 'vitest'
import { readQuickAgentConfig, settingsForMode, type QuickAgentJob } from './config'

const job = (overrides: Partial<QuickAgentJob> = {}): QuickAgentJob => ({
  id: 'job-1',
  name: '发布',
  prompt: '发布当前项目',
  model: 'gpt-5.6-luna',
  effort: 'max',
  mode: 'yolo',
  ...overrides,
})

describe('quick agent config', () => {
  it('drops invalid and duplicate job ids', () => {
    const config = readQuickAgentConfig({ jobs: [job(), job({ name: '重复' }), { id: '', name: '无效' }] })
    expect(config.jobs).toEqual([job()])
  })

  it('defaults legacy jobs to YOLO', () => {
    const value = { ...job() } as Record<string, unknown>
    delete value.mode
    expect(readQuickAgentConfig({ jobs: [value] }).jobs[0].mode).toBe('yolo')
  })

  it('maps each run mode to isolated thread settings', () => {
    expect(settingsForMode(job())).toMatchObject({ approvalPolicy: 'never', sandboxMode: 'danger-full-access' })
    expect(settingsForMode(job({ mode: 'auto-review' }))).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })
    expect(settingsForMode(job({ mode: 'manual' }))).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user' })
  })
})
