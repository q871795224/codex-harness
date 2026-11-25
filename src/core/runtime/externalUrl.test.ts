import { beforeEach, expect, it, vi } from 'vitest'
import { openUrl } from '@tauri-apps/plugin-opener'
import { runtime } from './bridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
beforeEach(() => { vi.mocked(openUrl).mockReset().mockResolvedValue(undefined) })

const reference = (extra: Record<string, string> = {}) => `seatalk://conversation?${new URLSearchParams({
  v: '1', owner_id: '11', target_type: 'group', target_id: '1197838',
  message_id: '000000009d2c9290', ...extra,
})}`

it('converts copied group references to the native message route before opening SeaTalk', async () => {
  await runtime.openExternalUrl(reference())
  // Native SeaTalk link fixture; the trailing base64 padding must survive query encoding.
  expect(openUrl).toHaveBeenCalledWith('seatalk://application/message/open?sid=FAIOBxteQVBLXEtDWQ%3D%3D&mid=000000009d2c9290')
})

it('uses buddy sessions for DMs and keeps the selected reply instead of its root', async () => {
  await runtime.openExternalUrl(reference({ target_type: 'user', target_id: '576308', root_message_id: '0000000000000001' }))
  expect(openUrl).toHaveBeenCalledWith('seatalk://application/message/open?sid=EQUFFhJeRVZEWENI&mid=000000009d2c9290')
})

it('can locate a root-only reference', async () => {
  await runtime.openExternalUrl(reference({ message_id: '', root_message_id: '0000000000000001' }))
  expect(openUrl).toHaveBeenCalledWith('seatalk://application/message/open?sid=FAIOBxteQVBLXEtDWQ%3D%3D&mid=0000000000000001')
})

it.each<Record<string, string>>([
  { v: '2' }, { target_type: 'channel' }, { target_id: '../bad' },
  { message_id: 'invalid' }, { message_id: '' },
])('rejects an unresolvable reference without merely activating SeaTalk: %j', async (extra) => {
  await expect(runtime.openExternalUrl(reference(extra))).rejects.toThrow('SeaTalk')
  expect(openUrl).not.toHaveBeenCalled()
})

it.each(['https://example.com', 'mailto:a@example.com', 'seatalk://application/message/open?sid=original&mid=0000000000000001'])(
  'preserves existing external links: %s', async (url) => {
    await runtime.openExternalUrl(url)
    expect(openUrl).toHaveBeenCalledWith(url)
  },
)

it('propagates native opener failures', async () => {
  vi.mocked(openUrl).mockRejectedValue(new Error('SeaTalk unavailable'))
  await expect(runtime.openExternalUrl(reference())).rejects.toThrow('SeaTalk unavailable')
})
