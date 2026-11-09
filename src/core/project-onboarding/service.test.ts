import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectOnboarding } from './service'
import { chunkHistory, parsePlan } from './prompt'
import type { AgentRunService } from '../agent-runs/types'
import type { ProjectDocService } from '../project-docs/types'
import type { OnboardingPorts, StoredOnboardingRequest } from './types'

afterEach(() => vi.useRealTimers())

function fixture() {
  const plan = { status: '目标和当前成果', log: ['验收通过'], decisions: ['只补缺失项'], openQuestions: ['跟进上线'], mutations: [] }
  const ports = { source: vi.fn(async () => ({ threadId:'t', title:'同步方案讨论', cwd:'/original' })), busy: vi.fn(() => false),
    history: vi.fn(async () => ['用户：早期背景', 'Agent：最新结论']), project: vi.fn(async () => ({projectId:'p',currentSeq:4,content:'已有项目背景',entries:[],consistent:true,contentHash:'h'})),
    binding: vi.fn(async () => null), commit: vi.fn(async () => ({projectId:'p', seq:5})), finish: vi.fn(async () => 'p') } satisfies OnboardingPorts
  const runs = { start: vi.fn(async () => ({runId:'run'})), snapshot: () => [{runId:'run',status:'completed'}],
    subscribe: vi.fn(() => () => {}), loadResult: vi.fn(async () => JSON.stringify(plan)), cancel: vi.fn().mockResolvedValue(undefined) } as unknown as AgentRunService
  const docs = {list:vi.fn(async () => []),get:vi.fn(async () => ({projectId:"p",name:"已有项目",currentSeq:4}))} as unknown as ProjectDocService
  const service = createProjectOnboarding(ports, docs, runs)
  const settings = { instanceId:'instance', model:'fixture-model', effort:'low' }
  return { service, ports, runs, settings, plan, docs }
}
describe('session project onboarding', () => {
  it('user requests show one card and do not start immediately', async () => {
    const f=fixture()
    const [one,two] = await Promise.all([f.service.request('t',{name:'用户填写的项目',instanceId:'instance'}), f.service.request('t')])
    expect(one.requestId).toBe(two.requestId)
    expect(f.service.snapshot().get('t')?.requestedBy).toBe('user')
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
  it('uses the source workspace at binding time if it changed while the card waited', async () => {
    const f=fixture(); await f.service.request('t')
    f.ports.source.mockResolvedValue({threadId:'t',title:'同步方案讨论',cwd:'/current'})
    await f.service.confirm('t',{mode:'create',name:'新项目',projectId:''},f.settings)
    expect(f.ports.finish).toHaveBeenCalledWith(expect.any(String),'t','/current')
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

describe('manual confirmation and restart', () => {
  function storage() {
    const saved=new Map<string,StoredOnboardingRequest>()
    return {saved,ports:{requests:async () => [...saved.values()],
      saveRequest:async (request:StoredOnboardingRequest) => {saved.set(request.id,structuredClone(request))},
      removeRequest:async (id:string) => {saved.delete(id)}}}
  }
  it('never starts a user draft until confirmation, including after editing or dismissing it', async () => {
    vi.useFakeTimers()
    const f=fixture()
    await f.service.request('t',{instanceId:'instance'})
    f.service.updateDraft('t',{mode:'create',name:'用户改名',projectId:''})
    await vi.advanceTimersByTimeAsync(600_000)
    expect(f.runs.start).not.toHaveBeenCalled()
    expect(f.service.snapshot().get('t')).toMatchObject({phase:'confirm',name:'用户改名'})
    f.service.dismiss('t')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(f.service.snapshot().size).toBe(0)
    expect(f.ports.commit).not.toHaveBeenCalled()
  })
  it('restores an expired legacy Agent proposal as a manual card', async () => {
    vi.useFakeTimers()
    const f=fixture(),db=storage()
    db.saved.set('legacy',{id:'legacy',threadId:'t',requestedBy:'agent',instanceId:'instance',mode:'create',name:'旧建议',projectId:'',phase:'confirm',autoConfirmAt:Date.now()-1})
    const restored=createProjectOnboarding({...f.ports,...db.ports},f.docs,f.runs)
    await restored.restoreSaved(); await vi.advanceTimersByTimeAsync(600_000)
    expect(restored.snapshot().get('t')).toMatchObject({phase:'confirm',requestedBy:'user',name:'旧建议'})
    expect(db.saved.get('legacy')).not.toHaveProperty('autoConfirmAt')
    expect(f.runs.start).not.toHaveBeenCalled()
    await restored.confirm('t',{mode:'create',name:'用户确认名称',projectId:''},f.settings)
    expect(f.ports.commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name:'用户确认名称'}))
  })
  it('does not replay an interrupted legacy run', async () => {
    vi.useFakeTimers()
    const f=fixture(),db=storage()
    db.saved.set('interrupted',{id:'interrupted',threadId:'t',requestedBy:'agent',instanceId:'instance',mode:'create',name:'默认项目',projectId:'',phase:'interrupted',autoConfirmAt:Date.now()-1})
    const restored=createProjectOnboarding({...f.ports,...db.ports},f.docs,f.runs)
    await restored.restoreSaved(); await vi.advanceTimersByTimeAsync(600_000)
    expect(restored.snapshot().get('t')?.phase).toBe('error')
    expect(f.runs.start).not.toHaveBeenCalled()
  })
  it('keeps user choices after restart without model work', async () => {
    vi.useFakeTimers()
    const f=fixture(),db=storage()
    const service=createProjectOnboarding({...f.ports,...db.ports},f.docs,f.runs)
    await service.request('t',{instanceId:'instance'})
    service.updateDraft('t',{mode:'create',name:'用户草稿',projectId:''})
    await vi.advanceTimersByTimeAsync(0)
    const restored=createProjectOnboarding({...f.ports,...db.ports},f.docs,f.runs)
    await restored.restoreSaved(); await vi.advanceTimersByTimeAsync(600_000)
    expect(restored.snapshot().get('t')?.name).toBe('用户草稿')
    expect(f.runs.start).not.toHaveBeenCalled()
    expect(JSON.stringify([...db.saved.values()])).not.toContain('早期背景')
  })
  it('does not summarize a busy source with no persisted messages', async () => {
    const f=fixture(); f.ports.busy.mockReturnValue(true); f.ports.history.mockResolvedValue([])
    await f.service.request('t')
    await f.service.confirm('t',{mode:'create',name:'新项目',projectId:''},f.settings)
    expect(f.runs.start).not.toHaveBeenCalled()
    expect(f.service.snapshot().get('t')?.error).toContain('没有可总结的对话')
  })
})

it('cancels stale join generation on the next one-second check and ignores late output', async () => {
  vi.useFakeTimers()
  const f=fixture()
  const unsubscribe=vi.fn()
  vi.mocked(f.runs.subscribe).mockReturnValue(unsubscribe)
  vi.spyOn(f.runs,'snapshot').mockReturnValue([])
  await f.service.request('t',{mode:'join',projectId:'p'})
  const pending=f.service.confirm('t',{mode:'join',name:'已有项目',projectId:'p'},f.settings)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.runs.start).toHaveBeenCalledTimes(1)
  vi.mocked(f.docs.get).mockResolvedValue({projectId:'p',name:'已有项目',currentSeq:5,createdAt:1,updatedAt:1})
  await vi.advanceTimersByTimeAsync(999)
  expect(f.runs.cancel).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(f.runs.cancel).toHaveBeenCalledWith('run')
  expect(unsubscribe).toHaveBeenCalled()
  expect(f.service.snapshot().get('t')).toMatchObject({phase:'error',error:expect.stringContaining('v4 → v5')})
  const calls=vi.mocked(f.docs.get).mock.calls.length
  vi.spyOn(f.runs,'snapshot').mockReturnValue([{runId:'run',status:'completed'}] as never)
  vi.mocked(f.runs.subscribe).mock.calls[0][0]()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.ports.commit).not.toHaveBeenCalled()
  expect(f.ports.finish).not.toHaveBeenCalled()
  expect(f.docs.get).toHaveBeenCalledTimes(calls)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps success until the user sends another message in the same conversation', async () => {
  vi.useFakeTimers()
  const f=fixture()
  await f.service.request('t')
  f.service.messageAccepted('t')
  expect(f.service.snapshot().has('t')).toBe(true)
  await f.service.confirm('t',{mode:'create',name:'项目',projectId:''},f.settings)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.service.snapshot().get('t')?.phase).toBe('done')
  f.service.messageAccepted('other')
  expect(f.service.snapshot().has('t')).toBe(true)
  f.service.messageAccepted('t')
  expect(f.service.snapshot().has('t')).toBe(false)
})

it('cancels a late-started job after already notifying about a newer version', async () => {
  vi.useFakeTimers()
  const f=fixture()
  let started!: (task: {runId:string}) => void
  vi.mocked(f.runs.start).mockImplementationOnce(() => new Promise(resolve => {started=resolve as typeof started}))
  await f.service.request('t')
  const pending=f.service.confirm('t',{mode:'join',name:'项目',projectId:'p'},f.settings)
  await vi.advanceTimersByTimeAsync(0)
  vi.mocked(f.docs.get).mockResolvedValue({projectId:'p',name:'项目',currentSeq:6,createdAt:1,updatedAt:1})
  await vi.advanceTimersByTimeAsync(1000)
  await pending
  expect(f.service.snapshot().get('t')?.phase).toBe('error')
  started({runId:'late'})
  await vi.advanceTimersByTimeAsync(0)
  expect(f.runs.cancel).toHaveBeenCalledWith('late')
  expect(f.ports.commit).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('checks again before saving and retries against the updated snapshot', async () => {
  vi.useFakeTimers()
  const f=fixture(); await f.service.request('t')
  vi.mocked(f.runs.loadResult).mockImplementationOnce(async () => {
    vi.mocked(f.docs.get).mockResolvedValue({projectId:'p',name:'项目',currentSeq:5,createdAt:1,updatedAt:1})
    return JSON.stringify(f.plan)
  })
  await f.service.confirm('t',{mode:'join',name:'项目',projectId:'p'},f.settings)
  expect(f.service.snapshot().get('t')?.phase).toBe('error')
  expect(f.ports.commit).not.toHaveBeenCalled()
  f.ports.project.mockResolvedValueOnce({projectId:'p',currentSeq:5,content:'新版背景',entries:[],consistent:true,contentHash:'new'})
  await f.service.confirm('t',{mode:'join',name:'项目',projectId:'p'},f.settings)
  expect(f.ports.commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({baseSeq:5}))
  expect(f.service.snapshot().get('t')?.phase).toBe('done')
  expect(vi.getTimerCount()).toBe(0)
})

it('stops checking after a model failure and preserves its error card on user messages', async () => {
  vi.useFakeTimers()
  const f=fixture(); await f.service.request('t')
  vi.mocked(f.runs.start).mockRejectedValueOnce(new Error('模型不可用'))
  await f.service.confirm('t',{mode:'join',name:'项目',projectId:'p'},f.settings)
  f.service.messageAccepted('t')
  expect(f.service.snapshot().get('t')).toMatchObject({phase:'error',error:'模型不可用'})
  expect(f.ports.commit).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels without saving when the version check fails', async () => {
  vi.useFakeTimers()
  const f=fixture()
  vi.spyOn(f.runs,'snapshot').mockReturnValue([])
  await f.service.request('t')
  const pending=f.service.confirm('t',{mode:'join',name:'项目',projectId:'p'},f.settings)
  await vi.advanceTimersByTimeAsync(0)
  vi.mocked(f.docs.get).mockRejectedValueOnce(new Error('项目已删除'))
  await vi.advanceTimersByTimeAsync(1000); await pending
  expect(f.runs.cancel).toHaveBeenCalledWith('run')
  expect(f.service.snapshot().get('t')?.error).toContain('无法检查项目版本')
  expect(f.ports.commit).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps checking unchanged versions without overlapping slow metadata requests', async () => {
  vi.useFakeTimers()
  const f=fixture()
  vi.spyOn(f.runs,'snapshot').mockReturnValue([])
  await f.service.request('t')
  const pending=f.service.confirm('t',{mode:'join',name:'项目',projectId:'p'},f.settings)
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.runs.cancel).not.toHaveBeenCalled()
  let release!: (value: Awaited<ReturnType<ProjectDocService['get']>>) => void
  vi.mocked(f.docs.get).mockImplementationOnce(() => new Promise(resolve => {release=resolve}))
  await vi.advanceTimersByTimeAsync(1000)
  const calls=vi.mocked(f.docs.get).mock.calls.length
  await vi.advanceTimersByTimeAsync(4000)
  expect(f.docs.get).toHaveBeenCalledTimes(calls)
  expect(f.runs.cancel).not.toHaveBeenCalled()
  release({projectId:'p',name:'项目',currentSeq:5,createdAt:1,updatedAt:1})
  await vi.advanceTimersByTimeAsync(0); await pending
  expect(f.runs.cancel).toHaveBeenCalledTimes(1)
  expect(f.ports.project).toHaveBeenCalledTimes(1)
  expect(f.ports.commit).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not launch the next history chunk after a version change', async () => {
  vi.useFakeTimers()
  const f=fixture()
  f.ports.history.mockResolvedValueOnce(['很长的历史'.repeat(20_000)])
  vi.spyOn(f.runs,'snapshot').mockReturnValue([])
  await f.service.request('t')
  const pending=f.service.confirm('t',{mode:'join',name:'项目',projectId:'p'},f.settings)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.service.snapshot().get('t')!.chunks).toBeGreaterThan(1)
  vi.mocked(f.docs.get).mockResolvedValue({projectId:'p',name:'项目',currentSeq:5,createdAt:1,updatedAt:1})
  await vi.advanceTimersByTimeAsync(1000); await pending
  expect(f.runs.start).toHaveBeenCalledTimes(1)
  expect(f.ports.commit).not.toHaveBeenCalled()
  expect(f.service.snapshot().get('t')?.phase).toBe('error')
})
