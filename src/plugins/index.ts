import type { HarnessPlugin, PluginInstanceRecord } from '../extensions/types'
import { trajectoryPlugin, defaultPluginInstances as trajectoryDefaults } from './trajectory'
import { lunaDefaultInstance, lunaPlugin } from './luna'
import { notificationsDefaultInstance, notificationsPlugin } from './notifications'
import { quickAgentDefaultInstance, quickAgentPlugin } from './quick-agent'
import { quickCommandDefaultInstances, quickCommandPlugin } from './quick-command'
import { seaTalkDefaultInstance, seaTalkPlugin } from './seatalk'
import { sessionLauncherDefaultInstance, sessionLauncherPlugin } from './session-launcher'
import { tasksDefaultInstance, tasksPlugin } from './tasks'
import { harnessFilesDefaultInstance, harnessFilesPlugin } from './harness-files'

export const builtInPlugins: HarnessPlugin[] = [sessionLauncherPlugin, tasksPlugin, trajectoryPlugin, harnessFilesPlugin, lunaPlugin, quickAgentPlugin, quickCommandPlugin, seaTalkPlugin, notificationsPlugin]
export const defaultPluginInstances: PluginInstanceRecord[] = [sessionLauncherDefaultInstance, tasksDefaultInstance, ...trajectoryDefaults, harnessFilesDefaultInstance, lunaDefaultInstance, quickAgentDefaultInstance, ...quickCommandDefaultInstances, seaTalkDefaultInstance, notificationsDefaultInstance]
