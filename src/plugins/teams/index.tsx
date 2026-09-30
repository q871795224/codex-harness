import { lazy, Suspense } from 'react'
import { Users } from 'lucide-react'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'
import type { TeamsService } from '../../core/teams/types'
const Workspace = lazy(() => import('../../features/teams/TeamWorkspace').then((m) => ({ default: m.TeamWorkspace })))
const AssignAction = lazy(() => import('../../features/teams/TeamWorkspace').then((m) => ({ default: m.AssignAction })))

export const teamsPlugin: HarnessPlugin = {
  manifest: { schemaVersion: 1, id: 'builtin.teams', name: '团队', description: '管理成员身份、任务协作和成员记忆。', version: '1.0.0', engine: { codexHarness: '^0.1.0' }, supportedScopes: ['global'] },
  activate(ctx) {
    const service = ctx.services.get<TeamsService>('harness.teams')
    ctx.slots.conversationTabs.register({ id: 'teams', label: '团队', icon: Users, order: 15, focusable: true, hideComposer: true,
      render: (context) => <Suspense fallback={<p>正在加载团队…</p>}><Workspace service={service} context={context} /></Suspense>,
    })
    ctx.slots.turnActions.register({ id: 'assign-member', order: 30,
      render: (props) => <Suspense fallback={null}><AssignAction service={service} context={props} /></Suspense>,
    })
  },
}
export const teamsDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.teams:default', pluginId: teamsPlugin.manifest.id, scope: { kind: 'global' }, enabled: true, config: {}, createdAt: 0, updatedAt: 0,
}
