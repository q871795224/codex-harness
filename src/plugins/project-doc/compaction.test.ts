import { expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import type { AgentRunService } from '../../core/agent-runs/types'
import { DEFAULT_PROJECT_DOC_CONFIG, readProjectDocConfig } from './config'
import { compactProject, waitForCompactionRun } from './compaction'
import { requestCompaction, watchCompaction } from './CompactionCard'

function deps() {
  const input = { jobId: 'job', baseSeq: 4, content: 'original', archivePath: '/archive/original.md', tokens: 20_000 }
  const docs = { threadProject: vi.fn(async () => 'test-'+crypto.randomUUID()), measure: vi.fn(async () => ({ seq: 4, tokens: 20_000 })),
    beginCompaction: vi.fn(async () => input), completeCompaction: vi.fn(async () => ({ newSeq: 5, beforeTokens: 20_000, afterTokens: 4000, archivePath: '/archive/before.md' })),
    cancelCompaction: vi.fn(async () => {}) } as unknown as ProjectDocService
  const runs = { start: vi.fn(async () => ({ runId: 'run' })), snapshot: vi.fn(() => [{ runId: 'run', status: 'completed' }]),
    subscribe: vi.fn(() => () => {}), loadResult: vi.fn(async () => '## Status\nresult'), cancel: vi.fn(async () => {}) } as unknown as AgentRunService
  return { docs, runs, config: DEFAULT_PROJECT_DOC_CONFIG, instanceId: 'instance', storage: { get: vi.fn(async () => null), set: vi.fn(async () => {}) } }
}
it('backs up through Harness before a read-only Codex run and saves automatically without content approval', async () => {
  const d=deps(); await compactProject(d,'project','thread','/workspace')
  expect(d.docs.beginCompaction).toHaveBeenCalledWith('project')
  expect(d.runs.start).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', mode: 'detached', workspaceAccess: 'read-only', parentThreadId: 'thread', settings: expect.objectContaining({ sandboxMode: 'read-only', approvalPolicy: 'never' }) }))
  expect(vi.mocked(d.runs.start).mock.calls[0][0].prompt).toContain('/archive/original.md')
  expect(d.docs.completeCompaction).toHaveBeenCalledWith('project','job','## Status\nresult')
  expect(d.docs.cancelCompaction).toHaveBeenCalledWith('project','job')
})
it('failed model runs release their job and never replace the document', async () => {
  const d=deps(); vi.mocked(d.runs.loadResult).mockRejectedValue(new Error('model failed'))
  await expect(compactProject(d,'project','thread','/workspace')).rejects.toThrow('model failed')
  expect(d.docs.completeCompaction).not.toHaveBeenCalled()
  expect(d.docs.cancelCompaction).toHaveBeenCalledWith('project','job')
})
it('timeout cancels the temporary run', async () => {
  vi.useFakeTimers(); const d=deps(); vi.mocked(d.runs.snapshot).mockReturnValue([])
  const run=waitForCompactionRun(d.runs,'run',100)
  const assertion=expect(run).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(101); await assertion
  expect(d.runs.cancel).toHaveBeenCalledWith('run'); vi.useRealTimers()
})
it('manual and automatic requests only prompt and never start a model before confirmation', async () => {
  const d=deps(); await requestCompaction(d,'thread',true); await requestCompaction(d,'thread',false)
  expect(d.docs.measure).toHaveBeenCalledTimes(2)
  expect(d.docs.beginCompaction).not.toHaveBeenCalled(); expect(d.runs.start).not.toHaveBeenCalled()
})
it('turn observer checks only successful completed replies and is disposable', async () => {
  const d=deps(); let handler!: (e: { status: string; threadId: string }) => void
  const remove=vi.fn()
  const stop=watchCompaction(d,{ onTurnCompleted: (h) => { handler=h as typeof handler; return remove }, openThread: vi.fn() })
  handler({status:'failed',threadId:'thread'}); expect(d.docs.measure).not.toHaveBeenCalled()
  handler({status:'completed',threadId:'thread'}); await vi.waitFor(() => expect(d.docs.measure).toHaveBeenCalledTimes(1))
  stop(); expect(remove).toHaveBeenCalledTimes(1)
})
it('defaults to 10,000 tokens and accepts finite positive configurable thresholds', () => {
  expect(readProjectDocConfig({}).compactionThreshold).toBe(10_000)
  expect(readProjectDocConfig({compactionThreshold:12_000}).compactionThreshold).toBe(12_000)
  for(const bad of [0,-1,NaN,Infinity,'123']) expect(readProjectDocConfig({compactionThreshold:bad}).compactionThreshold).toBe(10_000)
})
