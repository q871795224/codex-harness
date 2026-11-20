import movies from '../../../src-tauri/pets/dafeiyu/movies.json'

export type DafeiyuPhase = 'bridge' | 'action'
const idleBridges = new Set(['哈欠连天.mov', '悠闲哼歌.mov', '碎碎念-发呆碎碎念.mov'])

export function nextDafeiyuClip(count: number, phase: DafeiyuPhase, previous: number | null): number | null {
  const indices = movies.idle.slice(0, Math.max(0, count)).flatMap((name, index) =>
    idleBridges.has(name) === (phase === 'bridge') ? [index] : [])
  // null selects the original breathing video through the existing movie command.
  const choices: Array<number | null> = phase === 'bridge' ? [null, ...indices] : indices
  const different = choices.filter(index => index !== previous)
  const pool = different.length ? different : choices
  return pool[Math.floor(Math.random() * pool.length)] ?? null
}
