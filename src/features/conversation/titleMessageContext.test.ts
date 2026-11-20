import { expect, it, vi } from 'vitest'
import { titleMessageContext } from './titleMessageContext'
import { threadTitlePrompt } from './threadLifecycle'

const ref = (id = 1) => `seatalk://conversation?v=1&owner_id=11&target_type=group&target_id=123&message_id=${id.toString(16).padStart(16, '0')}`

it('resolves references even when the remaining request already describes a task', async () => {
  const read = vi.fn(async () => '主消息：DNS 工单执行失败\n选中消息：CMDB service 已删除')
  const source = await titleMessageContext(`排查 DNS 删除失败 [原消息](${ref()})，请解释原因`, read)
  expect(read).toHaveBeenCalledExactlyOnceWith(ref())
  expect(source.userText).toBe('排查 DNS 删除失败 [原消息]([SeaTalk 消息 1])，请解释原因')
  expect(source.messageContext).toContain('CMDB service 已删除')
  expect(source.messageContext).not.toContain('owner_id')
})

it('deduplicates reads and bounds multiple references and their combined text', async () => {
  const read = vi.fn(async (reference: string) => `${reference === ref() ? '第一个主题' : '其他主题'}\n${'长正文'.repeat(5000)}`)
  const source = await titleMessageContext([ref(), ref(), ref(2), ref(3), ref(4)].join('\n'), read)
  expect(read.mock.calls.map(([reference]) => reference)).toEqual([ref(), ref(2), ref(3)])
  expect(source.messageContext?.length).toBeLessThanOrEqual(4000)
  expect(source.messageContext).toContain('第一个主题')
  expect(source.messageContext).toContain('[SeaTalk 消息 3]')
  expect(source.userText).toContain(ref(4))
  const prompt = threadTitlePrompt('用户诉求'.repeat(5000), null, source.messageContext)!
  expect(prompt.length).toBeLessThan(8300)
  expect(prompt).toContain('第一个主题')
})

it('retains the original request on failures and keeps independently resolved references usable', async () => {
  const original = `${ref()} 帮我看看`
  expect(await titleMessageContext(original, async () => { throw new Error('offline') })).toEqual({ userText: original })
  const mixed = await titleMessageContext(`${ref()}\n${ref(2)}`, async reference => {
    if (reference === ref()) throw new Error('owner mismatch')
    return '另一条消息正文'
  })
  expect(mixed.userText).toContain(ref())
  expect(mixed.messageContext).toContain('另一条消息正文')
})

it('leaves ordinary text and pasted message bodies untouched without extra IO', async () => {
  const read = vi.fn()
  const userText = 'SeaTalk 群聊记录：DNS 删除工单失败，请帮忙分析'
  expect(await titleMessageContext(userText, read)).toEqual({ userText })
  expect(read).not.toHaveBeenCalled()
})
