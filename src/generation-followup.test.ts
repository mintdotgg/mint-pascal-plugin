import { describe, expect, it, vi } from 'vitest'
import { completeGeneratedModelOperation } from './types'
import type { MintOperation, MintPluginModel } from './types'

const generation: MintOperation = {
  object: 'operation',
  id: 'operation-generation',
  type: 'model_generation',
  generationMode: 'auto',
  status: 'succeeded',
  resource: { type: 'model', id: 'model-1' },
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:01:00.000Z',
}

const optimization: MintOperation = {
  ...generation,
  id: 'operation-optimization',
  type: 'model_optimization',
  status: 'running',
}

const optimized: MintOperation = {
  ...optimization,
  status: 'succeeded',
}

const model: MintPluginModel = {
  object: 'model',
  id: 'model-1',
  name: 'Wooden chair',
  prompt: 'A wooden chair',
  status: 'succeeded',
  assetStage: 'final',
  mintUrl: 'https://mint.gg/model-1',
  assets: {
    fbxUrl: null,
    glbUrl: 'https://cdn.mint.gg/model-1.glb',
    glbSizeBytes: null,
    objUrl: null,
    optimizedGlbUrl: null,
    optimizedGlbSizeBytes: null,
    previewImageUrl: null,
    stlUrl: null,
    thumbnailUrl: null,
    usdzUrl: null,
    bounds: null,
  },
  createdAt: null,
  updatedAt: null,
}

function dependencies(overrides: Partial<Parameters<typeof completeGeneratedModelOperation>[0]> = {}) {
  return {
    completed: generation,
    optimizeAfterGeneration: true,
    clearOptimizeAfterGeneration: vi.fn(),
    getModel: vi.fn(async () => model),
    refreshModels: vi.fn(async () => undefined),
    startOptimization: vi.fn(async () => optimization),
    watchOperation: vi.fn(async () => optimized),
    ...overrides,
  }
}

describe('generation optimization follow-up', () => {
  it('starts and watches optimization after a successful generation by default', async () => {
    const input = dependencies()

    await expect(completeGeneratedModelOperation(input)).resolves.toEqual(optimized)
    expect(input.startOptimization).toHaveBeenCalledWith('model-1')
    expect(input.watchOperation).toHaveBeenCalledWith(optimization)
    expect(input.refreshModels).toHaveBeenCalledTimes(2)
    expect(input.clearOptimizeAfterGeneration).toHaveBeenCalledOnce()
  })

  it('leaves the generated model alone when optimization is unchecked', async () => {
    const input = dependencies({ optimizeAfterGeneration: false })

    await expect(completeGeneratedModelOperation(input)).resolves.toEqual(generation)
    expect(input.startOptimization).not.toHaveBeenCalled()
    expect(input.refreshModels).toHaveBeenCalledOnce()
    expect(input.clearOptimizeAfterGeneration).toHaveBeenCalledOnce()
  })

  it('retains optimize-after intent when generation fails and can be retried', async () => {
    const failed = { ...generation, status: 'failed' as const }
    const input = dependencies({ completed: failed })

    await expect(completeGeneratedModelOperation(input)).resolves.toEqual(failed)
    expect(input.startOptimization).not.toHaveBeenCalled()
    expect(input.clearOptimizeAfterGeneration).not.toHaveBeenCalled()
  })
})
