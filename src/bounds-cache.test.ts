import { describe, expect, it } from 'vitest'
import { boundsCacheKey, isGlbBounds } from './bounds-cache'

describe('legacy GLB bounds cache', () => {
  it('invalidates measurements when updatedAt changes', () => {
    expect(boundsCacheKey('model-1', '2026-07-19T10:00:00.000Z')).not.toBe(
      boundsCacheKey('model-1', '2026-07-19T11:00:00.000Z'),
    )
  })

  it('accepts only four finite three-number vectors', () => {
    expect(isGlbBounds({ min: [-1, 0, -2], max: [1, 3, 2], size: [2, 3, 4], center: [0, 1.5, 0] })).toBe(true)
    expect(isGlbBounds({ min: [0, 0], max: [1, 1, 1], size: [1, 1, 1], center: [0.5, 0.5, Number.NaN] })).toBe(false)
  })
})
