// Local visual fixture. Uses the production card and stylesheet; no native calls or real data.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { OnboardingCard } from '../../../src/plugins/project-doc/OnboardingCard'
import { ConversationHeader } from '../../../src/features/conversation/ConversationView'
import type { OnboardingState } from '../../../src/core/project-onboarding/types'
import type { Thread } from '../../../src/core/domain/codex'
import '../../../src/styles.css'
const params = new URLSearchParams(location.search)
const dark = params.get('theme') === 'dark'
const mode = params.get('mode') === 'join' ? 'join' : 'create'
const phase = (params.get('phase') || 'confirm') as OnboardingState['phase']
const state: OnboardingState = {id:'visual-fixture',source:{threadId:'fixture', title:'DNS 同步方案与验收边界',cwd:'/example/dns-tools'},
  mode,phase,name:mode === 'join' ? (phase === 'done' ? 'AIOps 自动化运维' : '') : 'DNS 配置同步',projectId:mode === 'join' ? 'aiops' : '',requestedBy:'user',
  detail:phase === 'running' ? '正在对照项目文档，整理已有结论' : undefined,
  messages:46,chunks:3,completedChunks:1,
  ...(phase === 'done' ? {receipt:{projectId:'aiops',seq:12}} : {}),
  ...(phase === 'error' ? {error:'项目文档已更新，请重试。'} : {})}
const thread = {id:'fixture',cwd:'/example/dns-tools',name:state.source.title,preview:'',status:{type:'idle'},turns:[]} as unknown as Thread
const noop = () => {}
function Preview() {
  return <div className="app-shell" data-theme={dark ? 'dark' : 'light'} style={{display:'block',height:'100vh',background:dark?'#1b1d23':'#f8f9fc'}}>
    <div style={{maxWidth:1020,margin:'0 auto',height:'100%',background:dark?'#1f2228':'white',borderInline:dark?'1px solid #333743':'1px solid #e0e3eb'}}>
      <ConversationHeader thread={thread} workspace={null} gitContextResolved archived={false} isWorking={false} pinned={false} workspaceChanging={false} canChangeWorkspace={false}
        onRename={noop} onArchive={noop} onUnarchive={noop} onTogglePinned={noop} onChooseWorkspace={noop}/>
      <main style={{padding:'30px 38px',color:dark?'#c3c9d8':'#424859',fontSize:14,lineHeight:1.8}}>
        <div style={{maxWidth:700,margin:'0 0 28px auto',padding:'14px 18px',borderRadius:8,background:dark?'#292e39':'#f1f3f8'}}>同步这部分只补缺失项，目标已有的配置先保留。把这个决定和后续验收事项记下来。</div>
        <div style={{marginBottom:30}}>已经对齐同步范围。后续需要完成两项验收：验证增量同步，以及确认异常时的回滚流程。</div>
        <OnboardingCard state={state} projects={[{projectId:'aiops',name:'AIOps 自动化运维',currentSeq:11,createdAt:1,updatedAt:1}]} onConfirm={noop} onDismiss={noop} onOpen={noop}/>
        <div style={{marginTop:32,padding:'16px 18px',border:dark?'1px solid #3a3f4b':'1px solid #dce0e8',borderRadius:10,opacity:.6}}>继续讨论…</div>
      </main>
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<Preview/>);
