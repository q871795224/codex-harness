import { beforeEach, expect, it, vi } from 'vitest'
import type { JevRequest, JevResponse } from '../domain/jev'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'

beforeEach(() => { vi.mocked(invoke).mockReset() })

it('checks local configuration without passing credentials', async () => {
  vi.mocked(invoke).mockResolvedValue({ configured: true, model: 'typesafe-ai/jev' })
  expect(await runtime.jevStatus()).toEqual({ configured: true, model: 'typesafe-ai/jev' })
  expect(invoke).toHaveBeenCalledWith('jev_status')
})

it('passes all question types to native evaluation and preserves free versus unknown cost', async () => {
  const input: JevRequest = {
    state: { ticket: 'Checkout is unavailable.' },
    questions: {
      team: { type: 'choice', instructions: 'Who owns this?', criteria: { engineering: 'Failures', billing: 'Charges' } },
      severity: { type: 'score', instructions: 'Rate impact', criteria: ['Cosmetic', 'Blocked'] },
      blocked: { type: 'boolean', instructions: 'Are purchases blocked?' },
    },
  }
  const response: JevResponse = {
    model: 'typesafe-ai/jev',
    answers: {
      team: { type: 'choice', choice: 'engineering', probabilities: { engineering: 1, billing: 0 }, confidence: 1 },
      severity: { type: 'score', score: 1, probabilities: { '0': 0, '1': 1 } },
      blocked: { type: 'boolean', probability: 0.98 },
    },
    usage: { inputTokens: 421, outputTokens: 68 },
    costs: { cost: '0', marketCost: '0.000017682', gatewayCost: null },
  }
  vi.mocked(invoke).mockResolvedValue(response)
  expect(await runtime.jevEvaluate(input)).toEqual(response)
  expect(invoke).toHaveBeenCalledWith('jev_evaluate', { input })
})

it('propagates native errors without converting failures into answers', async () => {
  vi.mocked(invoke).mockRejectedValue('Jev HTTP 403：账户验证或访问权限未满足')
  await expect(runtime.jevEvaluate({ state: 'fixture', questions: {} })).rejects.toBe('Jev HTTP 403：账户验证或访问权限未满足')
})
