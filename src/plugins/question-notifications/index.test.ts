import { expect, it, vi } from 'vitest'
import { PluginHost } from '../../core/plugins/runtime'
import type { QuestionEvent } from '../../core/questions/types'
import { questionNotificationsDefaultInstance, questionNotificationsPlugin } from './index'
it('is enabled independently, sends each question and detaches when disabled',async()=>{
 let listener:((e:QuestionEvent)=>void)|undefined
 const send=vi.fn(async()=>undefined)
 const publish=vi.fn()
 const host=new PluginHost([questionNotificationsPlugin],{storage:()=>({async get(){return null},async set(){}}),services:{
  'harness.conversations':{onUserInputRequested:(fn:typeof listener)=>{listener=fn;return()=>{listener=undefined}}},
  'harness.questionNotifications':{send},'harness.notifications':{publish},
 }})
 expect(questionNotificationsDefaultInstance.enabled).toBe(true)
 await host.syncInstances([questionNotificationsDefaultInstance])
 const event:QuestionEvent={title:'Session',request:{id:7,threadId:'t',method:'item/tool/requestUserInput',params:{turnId:'turn',questions:[{id:'q1',question:'First'},{id:'q2',question:'Second'}]}}}
 listener!(event)
 await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(2))
 expect(send.mock.calls[0].slice(0,3)).toEqual(['http://127.0.0.1:8787','harness-notify','self'])
 send.mockRejectedValueOnce(new Error('offline'));listener!(event)
 await vi.waitFor(()=>expect(publish).toHaveBeenCalledOnce())
 await host.syncInstances([{...questionNotificationsDefaultInstance,enabled:false}]);expect(listener).toBeUndefined()
 await host.dispose()
})
