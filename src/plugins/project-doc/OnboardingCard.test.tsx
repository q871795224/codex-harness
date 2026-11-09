// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OnboardingCard } from './OnboardingCard'
import type { OnboardingState } from '../../core/project-onboarding/types'
afterEach(cleanup)
const state: OnboardingState = {id:'request',source:{threadId:'t',title:'同步方案讨论',cwd:'/repo'},mode:'create',name:'项目名称',projectId:'',phase:'confirm',requestedBy:'user'}
it('shows two inline choices with the proposed name and one confirmation action', () => {
  const confirm=vi.fn(),draft=vi.fn()
  render(<OnboardingCard state={state} projects={[{projectId:'p',name:'AIOps',currentSeq:4,createdAt:1,updatedAt:1}]} onConfirm={confirm} onDraft={draft} onDismiss={vi.fn()} onOpen={vi.fn()} />)
  expect(confirm).not.toHaveBeenCalled()
  expect(screen.getAllByRole('radio')).toHaveLength(2)
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('项目名称')
  expect(screen.getAllByRole('button')).toHaveLength(2) // confirm + close; choices are not buttons
  fireEvent.change(screen.getByLabelText('已有项目'),{target:{value:'p'}})
  expect(draft).toHaveBeenLastCalledWith({mode:'join',projectId:'p',name:'项目名称'})
  fireEvent.click(screen.getByRole('button',{name:'确认'}))
  expect(confirm).toHaveBeenCalledWith({mode:'join',projectId:'p',name:'AIOps'})
})
it('lets the user edit the suggested name without submitting it', () => {
  const confirm=vi.fn(),draft=vi.fn()
  render(<OnboardingCard state={state} projects={[]} onConfirm={confirm} onDraft={draft} onDismiss={vi.fn()} onOpen={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('项目名称'),{target:{value:'用户改名'}})
  expect(draft).toHaveBeenLastCalledWith({mode:'create',projectId:'',name:'用户改名'})
  expect(confirm).not.toHaveBeenCalled()
})
it('keeps a saved binding failure separate from regenerating project content', () => {
  const confirm=vi.fn()
  render(<OnboardingCard state={{...state,phase:'error',receipt:{projectId:'p',seq:4},error:'绑定未完成'}} projects={[]} onConfirm={confirm} onDismiss={vi.fn()} onOpen={vi.fn()} />)
  expect(screen.queryByRole('group',{name:'项目操作'})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'确认'}))
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button',{name:'取消项目申请'})).toBeNull()
})

it('waits for the confirmation button even after a long delay', async () => {
  vi.useFakeTimers()
  try {
    const confirm=vi.fn()
    render(<OnboardingCard state={state} projects={[]} onConfirm={confirm} onDraft={vi.fn()} onDismiss={vi.fn()} onOpen={vi.fn()}/>)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'确认'}))
    expect(confirm).toHaveBeenCalledExactlyOnceWith({mode:'create',name:'项目名称',projectId:''})
  } finally { vi.useRealTimers() }
})
