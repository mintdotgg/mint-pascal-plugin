import { describe, expect, it, vi } from 'vitest'
import { armMintAssetForPlacement } from './placement'
import type { GlbBounds, MintPluginModel } from './types'

const model: MintPluginModel = {
  object: 'model',
  id: 'chair-1',
  name: 'Chair',
  prompt: 'A wooden chair',
  status: 'succeeded',
  assetStage: 'final',
  assets: {
    fbxUrl: null,
    glbUrl: null,
    glbSizeBytes: null,
    objUrl: null,
    optimizedGlbUrl: 'https://cdn.mint.gg/chair.glb',
    optimizedGlbSizeBytes: null,
    previewImageUrl: null,
    stlUrl: null,
    thumbnailUrl: null,
    usdzUrl: null,
    bounds: null,
  },
  mintUrl: 'https://mint.gg/0xabc/chair-1',
  createdAt: null,
  updatedAt: '2026-07-19T10:00:00.000Z',
}

const bounds: GlbBounds = {
  min: [-1, 0, -2],
  max: [1, 3, 2],
  size: [2, 3, 4],
  center: [0, 1.5, 0],
}

describe('native Pascal placement', () => {
  it('clears selection and arms the native item tool in build mode', () => {
    const viewer = { setSelection: vi.fn() }
    const editor = { setSelectedItem: vi.fn(), setTool: vi.fn(), setMode: vi.fn() }
    const asset = armMintAssetForPlacement(model, bounds, { viewer, editor })
    expect(viewer.setSelection).toHaveBeenCalledWith({ selectedIds: [], zoneId: null })
    expect(editor.setSelectedItem).toHaveBeenCalledWith(asset)
    expect(editor.setTool).toHaveBeenCalledWith('item')
    expect(editor.setMode).toHaveBeenCalledWith('build')
  })
})
