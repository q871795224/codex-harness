// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '../../core/domain/codex'
import { UserInputRequestCard } from './UserInputRequestCard'

afterEach(cleanup)

function request(params: Record<string, unknown> = {}): ApprovalRequest {
  return {
    id: 'request-1',
    method: 'item/tool/requestUserInput',
    threadId: 'thread-1',
    params: {
      questions: [
        {
          id: 'approach',
          header: '方案',
          question: '你希望怎么处理？',
          options: [
            { label: '轻量修改', description: '只改必要代码' },
            { label: '完整实现', description: '覆盖完整交互' },
          ],
          isOther: true,
        },
        { id: 'token', header: '凭据', question: '输入一次性 Token', isSecret: true },
      ],
      ...params,
    },
  }
}

function card() {
  return screen.getByRole('article', { name: /问题 \d+ \/ \d+/ })
}

describe('UserInputRequestCard', () => {
  it('shows one question at a time and navigates with buttons and arrow keys', () => {
    render(<UserInputRequestCard request={request()} sendShortcut="mod-enter" onAnswer={vi.fn()} />)

    expect(screen.getByRole('heading', { name: '你希望怎么处理？' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '输入一次性 Token' })).toBeNull()
    expect(screen.getByRole('button', { name: '上一题' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))
    expect(screen.getByRole('heading', { name: '输入一次性 Token' })).toBeTruthy()
    fireEvent.keyDown(card(), { key: 'ArrowLeft' })
    expect(screen.getByRole('heading', { name: '你希望怎么处理？' })).toBeTruthy()
  })

  it('uses number keys to choose and advance, but requires manual submission on the last question', async () => {
    const serverRequest = request({
      questions: [
        { id: 'first', header: '一', question: '第一个问题？', options: [{ label: '甲' }, { label: '乙' }] },
        { id: 'second', header: '二', question: '第二个问题？', options: [{ label: '丙' }, { label: '丁' }] },
        { id: 'third', header: '三', question: '第三个问题？', options: [{ label: '戊' }, { label: '己' }] },
      ],
    })
    const onAnswer = vi.fn()
    render(<UserInputRequestCard request={serverRequest} sendShortcut="mod-enter" onAnswer={onAnswer} />)

    fireEvent.keyDown(card(), { key: '2' })
    expect(screen.getByRole('heading', { name: '第二个问题？' })).toBeTruthy()
    fireEvent.keyDown(card(), { key: '1' })
    expect(screen.getByRole('heading', { name: '第三个问题？' })).toBeTruthy()
    fireEvent.keyDown(card(), { key: '2' })
    expect(onAnswer).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '提交回答' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.keyDown(card(), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(serverRequest, {
      answers: {
        first: { answers: ['乙'] },
        second: { answers: ['丙'] },
        third: { answers: ['己'] },
      },
    }))
  })

  it('uses a text input for a custom answer and keeps secret answers masked', async () => {
    const serverRequest = request()
    const onAnswer = vi.fn()
    render(<UserInputRequestCard request={serverRequest} sendShortcut="mod-enter" onAnswer={onAnswer} />)

    const custom = screen.getByLabelText('方案的其他回答') as HTMLInputElement
    expect(custom.tagName).toBe('INPUT')
    fireEvent.change(custom, { target: { value: '保留现有接口' } })
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))
    const secret = screen.getByLabelText('凭据回答') as HTMLInputElement
    expect(secret.type).toBe('password')
    fireEvent.change(secret, { target: { value: 'temporary-token' } })
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(serverRequest, {
      answers: {
        approach: { answers: ['保留现有接口'] },
        token: { answers: ['temporary-token'] },
      },
    }))
  })

  it('can skip a request even when its questions cannot be displayed', async () => {
    const onAnswer = vi.fn()
    render(<UserInputRequestCard request={request({ questions: [] })} sendShortcut="mod-enter" onAnswer={onAnswer} />)
    expect(screen.getByText(/可以跳过/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(expect.anything(), { answers: {} }))
  })
})
