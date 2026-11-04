import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({invoke:vi.fn(async()=>null)}))
it('uses typed native commands without submitting answers or turns', async()=>{
  const locator={thread:'t',turn:'turn',request:'7',kind:'tool' as const,question:'q',revision:'a'.repeat(64)}
  await runtime.drainQuestionLinks();expect(invoke).toHaveBeenLastCalledWith('drain_question_links')
  await runtime.pendingUserInput(locator);expect(invoke).toHaveBeenLastCalledWith('pending_user_input',{threadId:'t',turnId:'turn',requestId:'7'})
  const input={locator,title:'Session',question:'Choose',options:['A']}
  await runtime.sendQuestionNotification('http://127.0.0.1:8787','notify','self',input)
  expect(invoke).toHaveBeenLastCalledWith('send_question_notification',{baseUrl:'http://127.0.0.1:8787',account:'notify',targetId:'self',input})
  vi.mocked(invoke).mockRejectedValueOnce(new Error('offline'))
  await expect(runtime.sendQuestionNotification('http://127.0.0.1:8787','notify','self',input)).rejects.toThrow('offline')
})
