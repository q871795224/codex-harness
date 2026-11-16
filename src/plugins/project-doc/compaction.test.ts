import { expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import { DEFAULT_PROJECT_DOC_CONFIG, readProjectDocConfig } from './config'
import { compactProject } from './compaction'
import { requestCompaction } from './CompactionCard'

function deps() {
  const input = { jobId: 'job', baseSeq: 4, content: 'original', archivePath: '/archive/original.md', tokens: 20_000 }
  const docs = { threadProject: vi.fn(async () => 'test-'+crypto.randomUUID()), measure: vi.fn(async () => ({ seq: 4, tokens: 20_000 })),
    generateArchive: vi.fn(async () => '## Status\nresult'),
    beginCompaction: vi.fn(async () => input), completeCompaction: vi.fn(async () => ({ newSeq: 5, beforeTokens: 20_000, afterTokens: 4000, archivePath: '/archive/before.md' })),
    cancelCompaction: vi.fn(async () => {}) } as unknown as ProjectDocService
  return { docs, config: DEFAULT_PROJECT_DOC_CONFIG, storage: { get: vi.fn(async () => null), set: vi.fn(async () => {}) } }
}
it('backs up before ephemeral generation and saves automatically without content approval', async () => {
  const d=deps(); await compactProject(d,'project','/workspace')
  expect(d.docs.beginCompaction).toHaveBeenCalledWith('project')
  expect(d.docs.generateArchive).toHaveBeenCalledWith({
    workspaceRoot: '/workspace', model: d.config.archiveModel, effort: d.config.archiveEffort,
    prompt: expect.stringContaining('/archive/original.md'),
  })
  expect(vi.mocked(d.docs.beginCompaction).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.docs.generateArchive).mock.invocationCallOrder[0])
  expect(d.docs.completeCompaction).toHaveBeenCalledWith('project','job','## Status\nresult')
  expect(d.docs.cancelCompaction).toHaveBeenCalledWith('project','job')
})
it('failed model runs release their job and never replace the document', async () => {
  const d=deps(); vi.mocked(d.docs.generateArchive).mockRejectedValue(new Error('model failed'))
  await expect(compactProject(d,'project','/workspace')).rejects.toThrow('model failed')
  expect(d.docs.completeCompaction).not.toHaveBeenCalled()
  expect(d.docs.cancelCompaction).toHaveBeenCalledWith('project','job')
})
it('save failure still releases the compaction job', async () => {
  const d=deps(); vi.mocked(d.docs.completeCompaction).mockRejectedValue(new Error('version conflict'))
  await expect(compactProject(d,'project','/workspace')).rejects.toThrow('version conflict')
  expect(d.docs.cancelCompaction).toHaveBeenCalledWith('project','job')
})
it('manual and automatic requests only prompt and never start a model before confirmation', async () => {
  const d=deps(); await requestCompaction(d,'thread',true); await requestCompaction(d,'thread',false)
  expect(d.docs.measure).toHaveBeenCalledTimes(2)
  expect(d.docs.beginCompaction).not.toHaveBeenCalled(); expect(d.docs.generateArchive).not.toHaveBeenCalled()
})
it('defaults to 10,000 tokens and accepts finite positive configurable thresholds', () => {
  expect(readProjectDocConfig({}).compactionThreshold).toBe(10_000)
  expect(readProjectDocConfig({compactionThreshold:12_000}).compactionThreshold).toBe(12_000)
  for(const bad of [0,-1,NaN,Infinity,'123']) expect(readProjectDocConfig({compactionThreshold:bad}).compactionThreshold).toBe(10_000)
})
