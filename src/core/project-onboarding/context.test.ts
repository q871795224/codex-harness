import { expect, it, vi } from 'vitest'
import { prepareProjectInput } from './context'
import type { ProjectDocService } from '../project-docs/types'
it('includes the new project before the first post-join message even before React has rendered its card', async () => {
  const docs={threadBinding:vi.fn(async () => ({projectId:'p',phase:'pending'})),context:vi.fn(async () => ({content:'已保存的项目记忆'}))} as unknown as ProjectDocService
  const original=[{type:'text' as const,text:'继续推进',text_elements:[]}]
  const prepared=await prepareProjectInput(docs,'t',original,10000)
  expect(prepared.projectId).toBe('p')
  expect(prepared.input).toHaveLength(2)
  expect(prepared.input[0]).toMatchObject({text:'<!-- project-doc: project_id=p thread_id=t -->\n\n已保存的项目记忆'})
  expect(prepared.input[1]).toEqual(original[0])
  await prepareProjectInput(docs,'t',prepared.input,10000)
  expect(docs.context).toHaveBeenCalledTimes(1)
})
it('keeps an unbound send unbound and propagates context failures so drafts are retained', async () => {
  const docs={threadBinding:vi.fn(async () => null),context:vi.fn()} as unknown as ProjectDocService
  expect((await prepareProjectInput(docs,'t',[],10000)).projectId).toBeNull()
  expect(docs.context).not.toHaveBeenCalled()
  vi.mocked(docs.threadBinding).mockResolvedValueOnce({projectId:'p',phase:'pending'})
  vi.mocked(docs.context).mockRejectedValueOnce(new Error('读取失败'))
  await expect(prepareProjectInput(docs,'t',[],10000)).rejects.toThrow('读取失败')
})
it('sends the original user input for native tools while retaining the binding lock intent', async () => {
  const docs={threadBinding:vi.fn(async () => ({projectId:'opaque-project',phase:'pending'})),context:vi.fn()} as unknown as ProjectDocService
  const original=[{type:'text' as const,text:'继续推进',text_elements:[]}]
  const prepared=await prepareProjectInput(docs,'native-thread',original,10000,true)
  expect(prepared.input).toBe(original)
  expect(prepared.projectId).toBe('opaque-project')
  expect(docs.context).not.toHaveBeenCalled()
})
