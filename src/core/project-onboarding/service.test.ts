import { describe, expect, it, vi } from 'vitest'
import { createProjectOnboarding } from './service'
import { chunkHistory, parsePlan } from './prompt'
import type { AgentRunService } from '../agent-runs/types'
import type { ProjectDocService } from '../project-docs/types'
import type { OnboardingPorts } from './types'

function fixture() {
  const plan = { status: '目标和当前成果', log: ['验收通过'], decisions: ['只补缺失项'], openQuestions: ['跟进上线'], mutations: [] }
  const ports = { source: vi.fn(async () => ({ threadId:'t', title:'同步方案讨论', cwd:'/original' })), busy: vi.fn(() => false),
    history: vi.fn(async () => ['用户：早期背景', 'Agent：最新结论']), project: vi.fn(async () => ({projectId:'p',currentSeq:4,content:'已有项目背景',entries:[],consistent:true,contentHash:'h'})),
    binding: vi.fn(async () => null), commit: vi.fn(async () => ({projectId:'p', seq:5})), finish: vi.fn(async () => 'p') } satisfies OnboardingPorts
  const runs = { start: vi.fn(async () => ({runId:'run'})), snapshot: () => [{runId:'run',status:'completed'}],
    subscribe: vi.fn(() => () => {}), loadResult: vi.fn(async () => JSON.stringify(plan)), cancel: vi.fn() } as unknown as AgentRunService
  const docs = {list:vi.fn(async () => []),get:vi.fn(async () => ({}))} as unknown as ProjectDocService
  const service = createProjectOnboarding(ports, docs, runs)
  const settings = { instanceId:'instance', model:'fixture-model', effort:'low' }
  return { service, ports, runs, settings, plan }
}
describe('session project onboarding', () => {
  it('Agent requests show one card and cannot start a task before user confirmation', async () => {
    const f=fixture()
    const [one,two] = await Promise.all([f.service.request('t',{requestedBy:'agent'}), f.service.request('t')])
    expect(one.requestId).toBe(two.requestId)
    expect(f.service.snapshot().get('t')?.requestedBy).toBe('agent')
    expect(f.runs.start).not.toHaveBeenCalled(); expect(f.ports.commit).not.toHaveBeenCalled()
    await f.service.confirm('t',{mode:'create', name:'新项目',projectId:''},f.settings)
    expect(f.service.snapshot().get('t')?.phase).toBe('done')
    expect(f.runs.start).toHaveBeenCalledWith(expect.objectContaining({workspaceAccess:'read-only',parentThreadId:'t',workspaceRoot:'/original'}))
    expect(f.ports.commit).toHaveBeenCalledWith(expect.objectContaining({name:'新项目',baseSeq:null,threadId:'t',decisions:['只补缺失项']}))
    const prompt = vi.mocked(f.runs.start).mock.calls[0][0].prompt
    expect(prompt).toContain('早期背景'); expect(prompt).toContain('最新结论')
    await f.service.confirm('t',{mode:'create',name:'duplicate',projectId:''},f.settings)
    expect(f.ports.commit).toHaveBeenCalledTimes(1)
  })
  it('passes the full target snapshot and aborts stale saves without binding', async () => {
    const f=fixture(); await f.service.request('t',{mode:'join',projectId:'p'})
    f.ports.commit.mockRejectedValueOnce(new Error('项目版本冲突'))
    await f.service.confirm('t',{mode:'join',name:'已有项目',projectId:'p'},f.settings)
    expect(f.ports.commit).toHaveBeenCalledWith(expect.objectContaining({baseSeq:4,name:null,projectId:'p'}))
    expect(vi.mocked(f.runs.start).mock.calls[0][0].prompt).toContain('已有项目背景')
    expect(f.ports.finish).not.toHaveBeenCalled()
    expect(f.service.snapshot().get('t')?.error).toContain('版本冲突')
  })
  it('retries only binding after a saved result, preserving the request ID and workspace', async () => {
    const f=fixture(); await f.service.request('t')
    f.ports.finish.mockRejectedValueOnce(new Error('暂时不可用'))
    await f.service.confirm('t',{mode:'create',name:'新项目',projectId:''},f.settings)
    const card=f.service.snapshot().get('t')!
    expect(card.receipt?.seq).toBe(5); expect(card.phase).toBe('error')
    await f.service.confirm('t',{mode:'join',name:'other',projectId:'other'},f.settings)
    expect(f.ports.commit).toHaveBeenCalledTimes(1)
    expect(f.ports.finish).toHaveBeenLastCalledWith(card.id,'t','/original')
    expect(f.service.snapshot().get('t')?.phase).toBe('done')
  })
  it('waits for an idle turn boundary before activating a saved binding', async () => {
    const f=fixture(); await f.service.request('t')
    f.ports.commit.mockImplementationOnce(async () => {f.ports.busy.mockReturnValue(true);return {projectId:'p',seq:5}})
    await f.service.confirm('t',{mode:'create',name:'新项目',projectId:''},f.settings)
    expect(f.service.snapshot().get('t')?.phase).toBe('binding'); expect(f.ports.finish).not.toHaveBeenCalled()
    f.ports.busy.mockReturnValue(false); await f.service.resumeBindings()
    expect(f.service.snapshot().get('t')?.phase).toBe('done')
  })
  it('chunks the whole history without dropping the earliest or oversized messages', () => {
    const text = ['early-'.repeat(20),'last-'.repeat(30)]
    const chunks=chunkHistory(text,30)
    expect(chunks.join('').replaceAll('\n','')).toBe(text.join(''))
    expect(chunks[0]).toContain('early-'); expect(chunks.at(-1)).toContain('last-')
    expect(() => parsePlan('{"status":"ok"}')).toThrow()
  })
  it('recovers saved receipts after restart without another model call or document write', async () => {
    const f=fixture()
    const ports={...f.ports,saved:vi.fn(async () => [{requestId:'saved',threadId:'t',projectId:'p',seq:5,name:'已有项目'}])}
    const restarted=createProjectOnboarding(ports,{} as ProjectDocService,f.runs)
    await restarted.restoreSaved()
    expect(restarted.snapshot().get('t')?.phase).toBe('done')
    expect(f.ports.finish).toHaveBeenCalledWith('saved','t','/original')
    expect(f.runs.start).not.toHaveBeenCalled(); expect(f.ports.commit).not.toHaveBeenCalled()
  })
  it('checks receipts before retrying a commit whose response was lost', async () => {
    const f=fixture(); let saved: Array<{requestId:string;threadId:string;projectId:string;seq:number;name:string}>=[]
    const service=createProjectOnboarding({...f.ports,saved:async () => saved},{} as ProjectDocService,f.runs)
    const requested=await service.request('t')
    f.ports.commit.mockImplementationOnce(async () => {
      saved=[{requestId:requested.requestId,threadId:'t',projectId:'p',seq:5,name:'已保存项目'}]
      throw new Error('response lost')
    })
    await service.confirm('t',{mode:'create',name:'新项目',projectId:''},f.settings)
    await service.confirm('t',{mode:'join',name:'其他项目',projectId:'other'},f.settings)
    expect(f.runs.start).toHaveBeenCalledTimes(1); expect(f.ports.commit).toHaveBeenCalledTimes(1)
    expect(service.snapshot().get('t')?.name).toBe('已保存项目')
    expect(service.snapshot().get('t')?.phase).toBe('done')
  })
})
