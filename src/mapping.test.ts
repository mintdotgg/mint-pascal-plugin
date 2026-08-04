import { describe, expect, it } from 'vitest'
import { boundsCacheKey, isGlbBounds } from './bounds-cache'
import { mintModelToAsset } from './mapping'
import type { GlbBounds, MintPluginModel } from './types'

const bounds: GlbBounds = {
  min: [-1, 2, -3],
  max: [5, 8, 7],
  size: [6, 6, 10],
  center: [2, 5, 2],
}

const model: MintPluginModel = {
  object: 'model',
  id: 'model-123',
  name: 'Reading chair',
  prompt: 'A comfortable reading chair',
  status: 'succeeded',
  assetStage: 'final',
  assets: {
    fbxUrl: null,
    glbUrl: 'https://cdn.mint.gg/chair-original.glb',
    glbSizeBytes: null,
    objUrl: null,
    optimizedGlbUrl: 'https://cdn.mint.gg/chair.glb',
    optimizedGlbSizeBytes: null,
    previewImageUrl: null,
    stlUrl: null,
    thumbnailUrl: 'https://cdn.mint.gg/chair.webp',
    usdzUrl: null,
    bounds,
  },
  mintUrl: 'https://mint.gg/owner/model-123',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
}

describe('Mint model mapping', () => {
  it('maps bounds into Pascal native item coordinates', () => {
    expect(mintModelToAsset(model, bounds)).toEqual({
      id: 'mint:model:model-123',
      category: 'furniture',
      name: 'Reading chair',
      thumbnail: 'https://cdn.mint.gg/chair.webp',
      source: 'mine',
      src: 'https://cdn.mint.gg/chair.glb',
      dimensions: [6, 6, 10],
      offset: [-2, -2, -2],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      tags: ['mint'],
    })
  })

  it('falls back to the canonical GLB and still rejects unsuccessful models', () => {
    expect(
      mintModelToAsset(
        { ...model, assets: { ...model.assets!, optimizedGlbUrl: null } },
        bounds,
      ).src,
    ).toBe('https://cdn.mint.gg/chair-original.glb')
    expect(() => mintModelToAsset({ ...model, status: 'failed' }, bounds)).toThrow('succeeded')
  })

  it('keys and validates legacy bounds by model version', () => {
    expect(boundsCacheKey(model.id, model.updatedAt)).toBe('model-123:2026-07-02T00:00:00.000Z')
    expect(isGlbBounds(bounds)).toBe(true)
    expect(isGlbBounds({ ...bounds, size: [1, Number.NaN, 3] })).toBe(false)
  })
})
