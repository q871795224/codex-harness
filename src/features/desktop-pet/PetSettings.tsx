import { PawPrint, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DesktopPetCatalog, PetKey } from '../../core/desktop-pet/types'
import { runtime } from '../../core/runtime/bridge'
import { PetSprite, usePetImage } from './PetSprite'
import './desktopPet.css'

function token(key: PetKey | null) { return key ? `${key.source}/${key.directory}` : '' }

export function PetSettings() {
  const [catalog, setCatalog] = useState<DesktopPetCatalog>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [size, setSize] = useState<number>()
  const selected = catalog?.pets.find(pet => token(pet.key) === token(catalog.selected))
  const preview = usePetImage(selected?.key)
  const percent = size ?? catalog?.scalePercent ?? 100

  const refresh = async () => { setCatalog(await runtime.desktopPetCatalog()) }
  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try { await action(); await refresh() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  async function importPet(format: 'folder' | 'frames') {
    const key = await runtime.desktopPetImport(format)
    if (!key) return
    await runtime.desktopPetSelect(key)
    await runtime.desktopPetVisibility(true)
  }
  async function downloadHd() {
    setDownloading(true)
    try { await run(runtime.desktopPetDownloadHd) }
    finally { setDownloading(false) }
  }
  useEffect(() => { void run(async () => {}) }, [])
  useEffect(() => {
    let disposed = false
    let remove: (() => void) | undefined
    void runtime.listenDesktopPetVisibility(visible => {
      if (!disposed) setCatalog(current => current ? { ...current, visible } : current)
    }).then(dispose => { if (disposed) dispose(); else remove = dispose }).catch(() => undefined)
    return () => { disposed = true; remove?.() }
  }, [])

  return <div className="settings-section codex-settings desktop-pet-settings">
    <div className="settings-section-title"><PawPrint size={17} /><div><h3>桌面宠物</h3><p>显示在应用上方，单击宠物打开助理，右键菜单可查看通知。</p></div></div>
    {catalog?.supported === false ? <p>桌面宠物当前支持 macOS。</p> : <>
      <div className="desktop-pet-setting-picker">
        <label>选择宠物 <select disabled={busy || !catalog?.pets.length} value={token(selected?.key ?? null)} onChange={event => {
          const pet = catalog?.pets.find(item => token(item.key) === event.target.value)
          if (pet) void run(() => runtime.desktopPetSelect(pet.key))
        }}>
          <option value="" disabled>{catalog?.pets.length ? '选择宠物' : '暂无宠物'}</option>
          {catalog?.pets.map(pet => <option key={token(pet.key)} value={token(pet.key)}>{pet.name} · {
            pet.key.source === 'builtin' ? '内置' : pet.version === 0 ? '图片' : `Codex v${pet.version}`}{pet.key.source === 'codex' ? ' · Codex 本机' : ''}</option>)}
        </select></label>
        {selected && preview.url && <div className="desktop-pet-setting-preview"><PetSprite pet={selected} url={preview.url} /></div>}
      </div>
      <div className="desktop-pet-setting-actions">
        <button type="button" disabled={busy || !catalog} onClick={() => void run(() => importPet('folder'))}>导入 Codex 宠物包</button>
        <button type="button" disabled={busy || !catalog} onClick={() => void run(() => importPet('frames'))}>导入图片</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => {})}><RefreshCw size={14} />刷新</button>
        <button type="button" disabled={busy || (!selected && !catalog?.visible)}
          onClick={() => void run(() => runtime.desktopPetVisibility(!catalog?.visible))}>{catalog?.visible ? '隐藏桌面宠物' : '显示桌面宠物'}</button>
      </div>
      {catalog?.pets.some(pet => pet.key.source === 'builtin' && pet.key.directory === 'dafeiyu') && (
        <div className="desktop-pet-setting-actions">
          {catalog.hdReady ? <span>大肥鱼原画素材已下载</span> :
            <button type="button" disabled={busy} onClick={() => void downloadHd()}>{downloading ? '正在从 GitHub 下载…' : '下载大肥鱼原画（约 139 MiB）'}</button>}
        </div>
      )}
      <div className="desktop-pet-scale">
        <label>桌面宠物大小 <output>{percent}%</output>
          <input aria-label="桌面宠物大小" type="range" min={20} max={400} value={percent}
            onChange={event => setSize(event.currentTarget.valueAsNumber)} disabled={!catalog || busy} />
        </label>
        <button type="button" disabled={!catalog || busy || percent === catalog.scalePercent}
          onClick={() => void run(async () => { await runtime.desktopPetSetScale(percent); setSize(undefined) })}>应用大小</button>
      </div>
    </>}
    {(error || preview.error) && <p role="alert">{error || preview.error}</p>}
  </div>
}
