// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectDocService } from '../../core/project-docs/types'
import { ProjectHistory } from './ProjectTab'
afterEach(cleanup)
const versions=[
 {seq:8,updatedBy:'harness:compaction',updatedAt:1,summary:'精简',contentHash:'h',operation:'compaction:7'},
 {seq:7,updatedBy:'user',updatedAt:0,summary:'before',contentHash:'h',operation:'edit'},
]
it('marks paired versions, previews archive and restores only after explicit confirmation', async()=>{
 const docs={readVersion:vi.fn(async()=> '## Status\n原文'),restoreVersion:vi.fn(async()=>({kind:'applied',newSeq:9,contentHash:'h'}))} as unknown as ProjectDocService
 const done=vi.fn()
 render(<ProjectHistory versions={versions} service={docs} projectId="p" currentSeq={8} onRestored={done} />)
 expect(screen.getByText('v8 · 整理生成')).toBeTruthy(); expect(screen.getByText('v7 · 整理前备份')).toBeTruthy()
 fireEvent.click(screen.getAllByRole('button',{name:'查看版本'})[1]); await screen.findByText('原文')
 expect(docs.readVersion).toHaveBeenCalledWith('p',7)
 fireEvent.click(screen.getByRole('button',{name:'恢复此版本'})); expect(docs.restoreVersion).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'确认恢复'}))
 await waitFor(()=>expect(done).toHaveBeenCalledOnce())
 expect(docs.restoreVersion).toHaveBeenCalledWith('p',7,8)
})
it('a newer document prevents a stale restoration without reporting success',async()=>{
 const docs={restoreVersion:vi.fn(async()=>({kind:'conflict',currentSeq:9,baseSeq:8}))} as unknown as ProjectDocService
 const done=vi.fn()
 render(<ProjectHistory versions={versions} service={docs} projectId="p" currentSeq={8} onRestored={done} />)
 fireEvent.click(screen.getByRole('button',{name:'恢复此版本'}));fireEvent.click(screen.getByRole('button',{name:'确认恢复'}))
 await screen.findByRole('alert');expect(done).not.toHaveBeenCalled()
})
