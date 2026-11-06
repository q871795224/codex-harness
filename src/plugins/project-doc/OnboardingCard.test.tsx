// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OnboardingCard } from './OnboardingCard'
import type { OnboardingState } from '../../core/project-onboarding/types'
afterEach(cleanup)
const state: OnboardingState = {id:'request',source:{threadId:'t',title:'同步方案讨论',cwd:'/repo'},mode:'create',name:'同步项目',projectId:'',phase:'confirm',requestedBy:'agent'}
it('does not submit until confirmed and allows selecting the existing target', () => {
  const confirm=vi.fn()
  render(<OnboardingCard state={state} projects={[{projectId:'p',name:'AIOps',currentSeq:4,createdAt:1,updatedAt:1}]} onConfirm={confirm} onDismiss={vi.fn()} onOpen={vi.fn()} />)
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'加入已有项目'}))
  fireEvent.change(screen.getByLabelText('目标项目'),{target:{value:'p'}})
  fireEvent.click(screen.getByRole('button',{name:'加入并补记'}))
  expect(confirm).toHaveBeenCalledWith({mode:'join',projectId:'p',name:'AIOps'})
})
it('keeps a saved binding failure separate from regenerating project content', () => {
  const confirm=vi.fn()
  render(<OnboardingCard state={{...state,phase:'error',receipt:{projectId:'p',seq:4},error:'绑定未完成'}} projects={[]} onConfirm={confirm} onDismiss={vi.fn()} onOpen={vi.fn()} />)
  expect(screen.queryByRole('group',{name:'项目操作'})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'继续完成绑定'}))
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button',{name:'关闭项目确认卡'})).toBeNull()
})
