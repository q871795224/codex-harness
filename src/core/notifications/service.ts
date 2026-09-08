import { runtime } from '../runtime/bridge'
import { createNotificationStore } from './store'

export const notifications = createNotificationStore({
  load: () => runtime.getAppState('notifications.history'),
  save: (value) => runtime.setAppState('notifications.history', value),
})
