import { describe, expect, it } from 'vitest'
import { reorderThreadIds } from './Sidebar'

describe('sidebar manual ordering', () => {
  it('places a dragged thread on the requested side of its target', () => {
    expect(reorderThreadIds(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(reorderThreadIds(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c'])
  })

  it('leaves the order unchanged for an invalid drag', () => {
    const ids = ['a', 'b']
    expect(reorderThreadIds(ids, 'missing', 'a', 'before')).toBe(ids)
    expect(reorderThreadIds(ids, 'a', 'a', 'after')).toBe(ids)
  })
})
