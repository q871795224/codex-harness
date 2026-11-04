// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useQuestionLinks } from './useQuestionLinks'
const mocks=vi.hoisted(()=>({drainQuestionLinks:vi.fn(),listenQuestionLinks:vi.fn(),publish:vi.fn()}))
vi.mock('../../core/runtime/bridge',()=>({runtime:mocks}))
vi.mock('../../core/notifications/service',()=>({notifications:{publish:mocks.publish}}))
afterEach(()=>{cleanup();vi.clearAllMocks()})
const link=(id:string)=>`codex-harness://question?thread=${id}&turn=t&request=7&kind=tool&question=q&revision=${'a'.repeat(64)}&option=0`
it('drains a cold-start link after readiness and handles running links without submitting anything',async()=>{
 let listener!:()=>void;const dispose=vi.fn()
 mocks.listenQuestionLinks.mockImplementation(async(fn)=>{listener=fn;return dispose})
 mocks.drainQuestionLinks.mockResolvedValueOnce([link('cold')]).mockResolvedValueOnce([link('running')])
 const open=vi.fn(async()=>undefined);const reveal=vi.fn()
 const {result,rerender,unmount}=renderHook(({ready})=>useQuestionLinks(ready,open,reveal),{initialProps:{ready:false}})
 expect(mocks.drainQuestionLinks).not.toHaveBeenCalled()
 rerender({ready:true})
 await waitFor(()=>expect(result.current?.locator.thread).toBe('cold'))
 expect(open).toHaveBeenLastCalledWith('cold')
 act(()=>listener())
 await waitFor(()=>expect(result.current?.locator.thread).toBe('running'))
 expect(open).toHaveBeenCalledTimes(2);expect(reveal).toHaveBeenCalledTimes(2)
 expect(result.current?.sequence).toBe(2)
 unmount();expect(dispose).toHaveBeenCalledOnce()
})
it('invalid external links do not open sessions',async()=>{
 mocks.listenQuestionLinks.mockResolvedValue(()=>undefined)
 mocks.drainQuestionLinks.mockResolvedValueOnce(['codex-harness://question?execute=true'])
 const open=vi.fn(async()=>undefined)
 renderHook(()=>useQuestionLinks(true,open,()=>undefined))
 await waitFor(()=>expect(mocks.publish).toHaveBeenCalledOnce())
 expect(open).not.toHaveBeenCalled()
})
