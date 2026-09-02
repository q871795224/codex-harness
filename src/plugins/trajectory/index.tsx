import { Route } from 'lucide-react'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'
import { TrajectoryView } from '../../features/conversation/TrajectoryView'

export const trajectoryPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.trajectory',
    name: '轨迹',
    description: '按时间顺序展示当前会话公开的消息、命令、工具与文件修改。',
    version: '1.0.1',
    engine: { codexHarness: '^0.1.0' },
    supportedScopes: ['global', 'workspace', 'thread'],
    supportedProviders: ['codex'],
  },
  activate(ctx) {
    ctx.slots.conversationTabs.register({
      id: 'trajectory',
      label: '轨迹',
      order: 20,
      icon: Route,
      render: ({ items }) => <TrajectoryView items={items} />,
    })
  },
}

export const builtInPlugins: HarnessPlugin[] = [trajectoryPlugin]

export const defaultPluginInstances: PluginInstanceRecord[] = [{
  instanceId: 'builtin.trajectory:default',
  pluginId: trajectoryPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}]
