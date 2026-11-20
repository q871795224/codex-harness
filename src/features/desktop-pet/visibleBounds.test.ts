import { expect, it } from 'vitest'
import { placeBounds, visibleBounds } from './visibleBounds'

it('excludes transparent padding and faint shadows from the character bounds', () => {
  const data = new Uint8ClampedArray(10 * 8 * 4)
  data[3] = 16
  for (let y = 2; y < 7; y++) for (let x = 3; x < 8; x++) data[(y * 10 + x) * 4 + 3] = 255
  expect(visibleBounds(data, 10, 8)).toEqual({ x: .3, y: .25, width: .5, height: .625 })
  const placed = placeBounds(visibleBounds(data, 10, 8)!, { x: .1, y: .2, width: .8, height: .6 })
  expect(placed.x).toBeCloseTo(.34)
  expect(placed.y).toBeCloseTo(.35)
  expect(placed.width).toBeCloseTo(.4)
  expect(placed.height).toBeCloseTo(.375)
})

it('has no hit target for an empty frame and keeps opaque edge pixels', () => {
  const data = new Uint8ClampedArray(4 * 3 * 4)
  expect(visibleBounds(data, 4, 3)).toBeNull()
  data[3] = 255
  data[data.length - 1] = 255
  expect(visibleBounds(data, 4, 3)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
})
