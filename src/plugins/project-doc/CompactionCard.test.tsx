// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CompactionCard } from './CompactionCard'
import { ProjectDocSettings } from './index'
import { projectDocDefaultInstance } from './index'
afterEach(cleanup)
it('shows the agreed copy and requires an explicit operation confirmation', () => {
  const confirm=vi.fn(), dismiss=vi.fn()
  render(<CompactionCard state={{projectId:'p',threadId:'t',tokens:12300,threshold:10000,phase:'confirm'}} onConfirm={confirm} onDismiss={dismiss} onOpen={vi.fn()} />)
  expect(screen.getByText('当前 12,300 / 门限 10,000 tokens。')).toBeTruthy()
  expect(screen.getByText('将完整归档原文并自动精简，可在项目历史中恢复。')).toBeTruthy()
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'暂不整理'})); expect(dismiss).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button',{name:'整理并归档'})); expect(confirm).toHaveBeenCalledOnce()
})
it('settings save the editable local-token threshold', async () => {
  const save=vi.fn(async () => {})
  render(<ProjectDocSettings instance={projectDocDefaultInstance} models={[]} saveConfig={save} />)
  fireEvent.change(screen.getByLabelText('精简提醒门限（tokens）'), {target:{value:'15000'}})
  fireEvent.click(screen.getByRole('button',{name:'保存'}))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({compactionThreshold:15000}))
})

it('automatic reminders respect threshold and cooldown; manual action bypasses both', async () => {
  const { requestCompaction, CompactionBanner } = await import('./CompactionCard')
  const projectId='reminder-'+crypto.randomUUID()
  const docs={threadProject:vi.fn(async()=>projectId),measure:vi.fn(async()=>({seq:1,tokens:10000}))}
  const storage={get:vi.fn(async()=>Date.now()),set:vi.fn(async()=>{})}
  const deps={docs,runs:{start:vi.fn()},config:{compactionThreshold:10000},instanceId:'i',storage} as any
  render(<CompactionBanner deps={deps} props={{threadId:'t',threadCwd:'/w',workspaceRoot:'/w',checkoutRoot:'/w'}} />)
  await requestCompaction(deps,'t',false)
  expect(screen.queryByRole('button',{name:'整理并归档'})).toBeNull()
  docs.measure.mockResolvedValue({seq:2,tokens:12300})
  await requestCompaction(deps,'t',false)
  expect(screen.queryByRole('button',{name:'整理并归档'})).toBeNull()
  await requestCompaction(deps,'t',true)
  await screen.findByRole('button',{name:'整理并归档'})
  expect(deps.runs.start).not.toHaveBeenCalled()
})

it('confirmation runs once and saves without a second content-approval step', async()=>{
  const { requestCompaction, CompactionBanner }=await import('./CompactionCard')
  const projectId='run-'+crypto.randomUUID()
  const docs={threadProject:vi.fn(async()=>projectId),measure:vi.fn(async()=>({seq:1,tokens:12300})),
    beginCompaction:vi.fn(async()=>({jobId:'j',baseSeq:1,content:'old',archivePath:'/archive',tokens:12300})),
    completeCompaction:vi.fn(async()=>({newSeq:2,beforeTokens:12300,afterTokens:3400,archivePath:'/archive'})),cancelCompaction:vi.fn(async()=>{})}
  const runs={start:vi.fn(async()=>({runId:'r'})),subscribe:()=>()=>{},snapshot:()=>[{runId:'r',status:'completed'}],loadResult:async()=> 'new body'}
  const deps={docs,runs,config:{compactionThreshold:10000},instanceId:'i',storage:{get:async()=>null,set:async()=>{}}} as any
  render(<CompactionBanner deps={deps} props={{threadId:'run-thread',threadCwd:'/w',workspaceRoot:'/w',checkoutRoot:'/w'}} />)
  await requestCompaction(deps,'run-thread',true)
  const button=await screen.findByRole('button',{name:'整理并归档'})
  fireEvent.click(button);fireEvent.click(button)
  await screen.findByText('项目文档已整理')
  expect(docs.completeCompaction).toHaveBeenCalledOnce();expect(runs.start).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button',{name:'整理并归档'})).toBeNull()
})

it('completed-turn reminders use the resolved banner settings and deduplicate event delivery', async()=>{
  const { watchCompaction, CompactionBanner }=await import('./CompactionCard')
  let handler!: (e:any)=>void
  const stop=watchCompaction({onUserInputRequested:()=>()=>{},onTurnCompleted:(h)=>{handler=h;return ()=>{}},onMessageSubmitted:()=>()=>{},openThread:vi.fn()})
  const docs={threadProject:vi.fn(async()=> 'scoped-'+crypto.randomUUID()),measure:vi.fn(async()=>({seq:1,tokens:12300}))}
  const deps={docs,runs:{},config:{compactionThreshold:15000},instanceId:'scoped',storage:{get:async()=>null,set:async()=>{}}} as any
  render(<CompactionBanner deps={deps} props={{threadId:'scope-thread',threadCwd:'/w',workspaceRoot:'/w',checkoutRoot:'/w'}} />)
  act(()=>handler({threadId:'scope-thread',turnId:'1',status:'failed'}))
  expect(docs.measure).not.toHaveBeenCalled()
  act(()=>{handler({threadId:'scope-thread',turnId:'1',status:'completed'});handler({threadId:'scope-thread',turnId:'1',status:'completed'})})
  await vi.waitFor(()=>expect(docs.measure).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('button',{name:'整理并归档'})).toBeNull()
  stop()
})
