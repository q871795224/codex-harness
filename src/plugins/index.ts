import type { HarnessPlugin, PluginInstanceRecord } from '../extensions/types'
import { trajectoryPlugin, defaultPluginInstances as trajectoryDefaults } from './trajectory'
import { temporaryAgentDefaultInstance, temporaryAgentPlugin } from './temporary-agent'
import { seaTalkDefaultInstance, seaTalkPlugin } from './seatalk'
import { sessionLauncherDefaultInstance, sessionLauncherPlugin } from './session-launcher'

export const builtInPlugins: HarnessPlugin[] = [sessionLauncherPlugin, trajectoryPlugin, temporaryAgentPlugin, seaTalkPlugin]
export const defaultPluginInstances: PluginInstanceRecord[] = [sessionLauncherDefaultInstance, ...trajectoryDefaults, temporaryAgentDefaultInstance, seaTalkDefaultInstance]
