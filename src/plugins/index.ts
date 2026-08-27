import type { HarnessPlugin, PluginInstanceRecord } from '../extensions/types'
import { trajectoryPlugin, defaultPluginInstances as trajectoryDefaults } from './trajectory'
import { lunaDefaultInstance, lunaPlugin } from './luna'
import { seaTalkDefaultInstance, seaTalkPlugin } from './seatalk'
import { sessionLauncherDefaultInstance, sessionLauncherPlugin } from './session-launcher'
import { tasksDefaultInstance, tasksPlugin } from './tasks'

export const builtInPlugins: HarnessPlugin[] = [sessionLauncherPlugin, tasksPlugin, trajectoryPlugin, lunaPlugin, seaTalkPlugin]
export const defaultPluginInstances: PluginInstanceRecord[] = [sessionLauncherDefaultInstance, tasksDefaultInstance, ...trajectoryDefaults, lunaDefaultInstance, seaTalkDefaultInstance]
