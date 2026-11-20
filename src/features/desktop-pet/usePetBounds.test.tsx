// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePetBounds } from './usePetBounds'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('follows the visible video frame, including letterboxing, then returns to the sprite', () => {
  vi.useFakeTimers()
  vi.stubGlobal('innerWidth', 200)
  vi.stubGlobal('innerHeight', 200)
  vi.stubGlobal('Image', class { src = ''; complete = true; naturalWidth = 1536; naturalHeight = 1872 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 20, y: 10, width: 160, height: 180 } as DOMRect)
  const drawImage = vi.fn()
  let empty = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(), drawImage,
    getImageData: () => {
      const data = new Uint8ClampedArray(192 * 216 * 4)
      if (!empty) for (let y = 72; y < 144; y++) for (let x = 48; x < 144; x++) data[(y * 192 + x) * 4 + 3] = 255
      return { data }
    },
  } as unknown as CanvasRenderingContext2D)
  function Preview() {
    const { artwork, bounds } = usePetBounds('blob:sheet')
    return <><div ref={artwork}>
      <span className="desktop-pet-sprite" data-row="6" data-col="2" data-rows="9" />
      <video data-ready="true" ref={element => {
        if (element) Object.defineProperties(element, {
          readyState: { value: 2 }, videoWidth: { value: 640 }, videoHeight: { value: 360 },
        })
      }} />
    </div><output>{JSON.stringify(bounds)}</output></>
  }
  const { container } = render(<Preview />)
  // A 16:9 video is centered in a tall artwork canvas, without stretching.
  expect(drawImage).toHaveBeenLastCalledWith(container.querySelector('video'), 0, 0, 640, 360, 0, 54, 192, 108)
  const bounds = JSON.parse(screen.getByRole('status').textContent!)
  expect(bounds.x).toBeCloseTo(.3)
  expect(bounds.y).toBeCloseTo(.35)
  expect(bounds.width).toBeCloseTo(.4)
  expect(bounds.height).toBeCloseTo(.3)
  container.querySelector('video')!.dataset.ready = 'false'
  act(() => { vi.advanceTimersByTime(100) })
  expect(drawImage.mock.lastCall?.slice(1, 5)).toEqual([384, 1248, 192, 208])
  const image = document.createElement('img')
  image.className = 'desktop-pet-idle-animation'
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 400 }, naturalHeight: { value: 400 } })
  container.querySelector('div')!.append(image)
  act(() => { vi.advanceTimersByTime(100) })
  expect(drawImage).toHaveBeenLastCalledWith(image, 0, 0, 400, 400, 0, 12, 192, 192)
  empty = true
  act(() => { vi.advanceTimersByTime(100) })
  expect(screen.getByRole('status').textContent).toBe('null')
})
