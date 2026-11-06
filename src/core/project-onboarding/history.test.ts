import { beforeEach, expect, it, vi } from 'vitest'
import { onboardingHistory } from './history'
import { appServer } from '../runtime/appServerClient'
vi.mock('../runtime/appServerClient', () => ({appServer:{listTurns:vi.fn()}}))
vi.mock('../runtime/bridge', () => ({runtime:{}}))
beforeEach(() => vi.clearAllMocks())
const source={threadId:'source',title:'来源会话',cwd:'/repo'}
it('reads every page, including early turns never rendered in the UI', async () => {
  vi.mocked(appServer.listTurns).mockResolvedValueOnce({data:[{id:'early',status:'completed',items:[{id:'i',type:'agentMessage',text:'最初的约束'}]}],nextCursor:'next'} as never)
    .mockResolvedValueOnce({data:[{id:'late',status:'completed',items:[{id:'j',type:'agentMessage',text:'后来的纠正'}]}],nextCursor:null} as never)
  expect(await onboardingHistory(source)).toEqual(['agentMessage:\n最初的约束','agentMessage:\n后来的纠正'])
  expect(appServer.listTurns).toHaveBeenNthCalledWith(2,expect.objectContaining({cursor:'next',sortDirection:'asc',itemsView:'full'}))
})
it('labels active work as unfinished and rejects cursor loops', async () => {
  vi.mocked(appServer.listTurns).mockResolvedValueOnce({data:[{id:'active',status:'inProgress',items:[]}],nextCursor:null} as never)
  expect((await onboardingHistory(source))[0]).toContain('仍在执行')
  vi.mocked(appServer.listTurns).mockResolvedValue({data:[],nextCursor:'loop'})
  await expect(onboardingHistory(source)).rejects.toThrow('分页未前进')
})
