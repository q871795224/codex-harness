import { expect, it } from 'vitest'
import type { AppNotification } from '../notifications/store'
import { desktopPetActivity } from './activity'

const notice = (id: string, patch: Partial<AppNotification> = {}): AppNotification => ({
  id, source: 'test', title: id, threadId: id, level: 'info', createdAt: 0, updatedAt: 0, read: false, ...patch,
})

it('prioritizes pending input, then failed and watched completions, grouping by session', () => {
  const waiting = notice('waiting', { level: 'warning', state: 'pending', attention: 'action', read: true })
  const failure = notice('failure', { level: 'error', updatedAt: 5 })
  const ready = notice('watch', { state: 'done', watchThread: true, updatedAt: 10 })
  expect(desktopPetActivity([ready, failure, waiting, notice('duplicate', { threadId: 'failure', level: 'error' })], true, 20))
    .toEqual({ status: 'waiting', count: 3, threadId: 'waiting', notificationId: 'waiting' })
  expect(desktopPetActivity([ready, failure], true, 20).status).toBe('failed')
  expect(desktopPetActivity([ready], true, 20).status).toBe('ready')
})

it('ignores ordinary results, silent records, snoozed items and resolved requests', () => {
  const records = [
    notice('ordinary', { state: 'done' }),
    notice('silent', { silent: true, level: 'error' }),
    notice('snoozed', { remindAt: 30, level: 'error' }),
    notice('answered', { resolved: true, state: 'pending', attention: 'action' }),
  ]
  expect(desktopPetActivity(records, false, 20)).toEqual({ status: 'idle', count: 0, threadId: null, notificationId: null })
  expect(desktopPetActivity(records, true, 20).status).toBe('running')
})
