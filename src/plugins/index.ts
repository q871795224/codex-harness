import type { HarnessPlugin, PluginInstanceRecord } from '../extensions/types'
import { trajectoryPlugin, defaultPluginInstances as trajectoryDefaults } from './trajectory'
import { temporaryAgentDefaultInstance, temporaryAgentPlugin } from './temporary-agent'

export const builtInPlugins: HarnessPlugin[] = [trajectoryPlugin, temporaryAgentPlugin]
export const defaultPluginInstances: PluginInstanceRecord[] = [...trajectoryDefaults, temporaryAgentDefaultInstance]
