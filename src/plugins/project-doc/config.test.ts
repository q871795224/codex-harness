import { expect, it } from 'vitest'
import { createProjectDocInstanceConfig, readProjectDocConfig } from './config'

it('defaults archive runs to GPT-6 Luna and preserves configured models', () => {
  expect(createProjectDocInstanceConfig()).toMatchObject({ archiveModel: 'gpt-6-luna', archiveEffort: 'max' })
  expect(readProjectDocConfig({})).toMatchObject({ archiveModel: 'gpt-6-luna', archiveEffort: 'max' })
  expect(readProjectDocConfig({ archiveModel: 'custom', archiveEffort: 'high' })).toMatchObject({ archiveModel: 'custom', archiveEffort: 'high' })
})
