// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ApprovalRequest } from '../../core/domain/codex'
import type { QuestionNavigation } from '../../core/questions/types'
import { PersistentUserInputCard } from './PersistentUserInputCard'
const runtime=vi.hoisted(()=>({getAppState:vi.fn(async()=>JSON.stringify({q1:{value:'已有草稿',other:true}})),setAppState:vi.fn(async()=>undefined),pendingUserInput:vi.fn(),openExternalUrl:vi.fn()}))
vi.mock('../../core/runtime/bridge',()=>({runtime}))
vi.mock('../../core/questions/links',()=>({questionRevision:vi.fn(async()=> 'a'.repeat(64))}))
afterEach(()=>{cleanup();vi.clearAllMocks()})
function request(id:string):ApprovalRequest {return {id,threadId:'t',method:'item/tool/requestUserInput',params:{turnId:'turn',questions:[
 {id:'q1',header:'方案',question:'Choose',isOther:true,options:[{label:'A'},{label:'B'}]}, {id:'q2',header:'说明',question:'Details'},
]}}}
function navigation(id:string,revision='a'.repeat(64)):QuestionNavigation {return {sequence:1,locator:{thread:'t',turn:'turn',request:id,kind:'tool',question:'q1',revision,option:1}}}
it('appends to the existing question draft, preserves other questions and submits only after the user clicks',async()=>{
 const r=request('append-case');runtime.pendingUserInput.mockResolvedValue(r)
 const onAnswer=vi.fn(async()=>undefined)
 render(<PersistentUserInputCard request={r} navigation={navigation('append-case')} sendShortcut="mod-enter" onAnswer={onAnswer}/>)
 const input=await screen.findByLabelText('方案的其他回答')
 await waitFor(()=>expect((input as HTMLTextAreaElement).value).toBe('已有草稿\nB'))
 expect(onAnswer).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'下一题'}))
 fireEvent.change(screen.getByLabelText('说明回答'),{target:{value:'保留说明'}})
 fireEvent.click(screen.getByRole('button',{name:'提交回答'}))
 await waitFor(()=>expect(onAnswer).toHaveBeenCalledOnce())
 expect(onAnswer.mock.calls[0]).toEqual([r,{answers:{q1:{answers:['已有草稿\nB']},q2:{answers:['保留说明']}}}])
})
it('rejects an old option revision and a request no longer pending without modifying drafts',async()=>{
 const r=request('stale-case');runtime.pendingUserInput.mockResolvedValue(r)
 const onAnswer=vi.fn()
 const view=render(<PersistentUserInputCard request={r} navigation={navigation('stale-case','b'.repeat(64))} sendShortcut="mod-enter" onAnswer={onAnswer}/>)
 await screen.findByText('问题或选项已更新，请在当前表单重新选择。')
 expect((screen.getByLabelText('方案的其他回答') as HTMLTextAreaElement).value).toBe('已有草稿')
 runtime.pendingUserInput.mockResolvedValue(null)
 view.rerender(<PersistentUserInputCard request={r} navigation={{...navigation('stale-case'),sequence:2}} sendShortcut="mod-enter" onAnswer={onAnswer}/>)
 await screen.findByText('当前没有这个待回答请求，请查看会话中的实际状态。')
 expect(onAnswer).not.toHaveBeenCalled()
 expect((screen.getByLabelText('方案的其他回答') as HTMLTextAreaElement).value).toBe('已有草稿')
})
it('restores unsent question answers after changing conversations',async()=>{
 const r=request('restore-case');const onAnswer=vi.fn()
 const view=render(<PersistentUserInputCard request={r} sendShortcut="mod-enter" onAnswer={onAnswer}/>)
 const input=await screen.findByLabelText('方案的其他回答')
 fireEvent.change(input,{target:{value:'未发送修改'}})
 view.unmount()
 render(<PersistentUserInputCard request={r} sendShortcut="mod-enter" onAnswer={onAnswer}/>)
 await waitFor(()=>expect((screen.getByLabelText('方案的其他回答') as HTMLTextAreaElement).value).toBe('未发送修改'))
 expect(onAnswer).not.toHaveBeenCalled()
})
