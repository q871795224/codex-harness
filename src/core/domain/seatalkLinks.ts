// AI conversation references are not native SeaTalk routes. Convert only at open
// time so copied references retain their owner and thread context for Bridge reads.
export function nativeSeaTalkUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'seatalk:' || url.hostname !== 'conversation') return value

  const params = url.searchParams
  const type = params.get('target_type')
  const id = params.get('target_id') ?? ''
  const mid = params.get('message_id') || params.get('root_message_id') || ''
  if (params.get('v') !== '1' || !['user', 'group'].includes(type ?? '')
    || !/^[1-9]\d*$/.test(id) || !/^[0-9a-f]{16}$/i.test(mid)) {
    throw new Error('SeaTalk 消息引用无效，无法定位会话')
  }

  // SeaTalk's native /message/open handler decodes sid using this session-label
  // encoding (XOR with "spark", then base64). It resolves replies by message ID.
  const session = `${type === 'user' ? 'buddy' : 'group'}-${id}`
  const key = 'spark'
  const sid = btoa(Array.from(session, (char, index) => String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(index % key.length))).join(''))
  const native = new URL('seatalk://application/message/open')
  native.searchParams.set('sid', sid)
  native.searchParams.set('mid', mid)
  return native.href
}
