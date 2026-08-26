import type { HarnessPlugin, PluginInstanceRecord } from '../extensions/types'
import { trajectoryPlugin, defaultPluginInstances as trajectoryDefaults } from './trajectory'
import { temporaryAgentDefaultInstance, temporaryAgentPlugin } from './temporary-agent'
import { seaTalkDefaultInstance, seaTalkPlugin } from './seatalk'

export const builtInPlugins: HarnessPlugin[] = [trajectoryPlugin, temporaryAgentPlugin, seaTalkPlugin]
export const defaultPluginInstances: PluginInstanceRecord[] = [...trajectoryDefaults, temporaryAgentDefaultInstance, seaTalkDefaultInstance]
