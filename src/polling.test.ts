import { describe, expect, it, vi } from 'vitest'
import { pollMintModelUntilOptimized, pollMintOperation } from './polling'
import type { MintOperation, MintPluginModel } from './types'

function operation(
  status: MintOperation['status'],
  generationMode: MintOperation['generationMode'] = 'auto',
): MintOperation {
  return {
    object: 'operation',
    id: 'op_1',
    type: 'model_generation',
    generationMode,
    status,
    resource: { type: 'model', id: 'model_1' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('operation polling', () => {
  it('uses exponential delay, respects Retry-After, and returns terminal states', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: operation('queued'), retryAfterMs: null })
      .mockResolvedValueOnce({ data: operation('running'), retryAfterMs: 9_000 })
      .mockResolvedValueOnce({ data: operation('partially_succeeded'), retryAfterMs: null })
    const sleep = vi.fn(async (_milliseconds: number) => {})
    const result = await pollMintOperation('op_1', get, { sleep })
    expect(result.status).toBe('partially_succeeded')
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([2_000, 9_000])
  })

  it('keeps polling through preview_ready for auto operations', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: operation('preview_ready'), retryAfterMs: null })
      .mockResolvedValueOnce({ data: operation('running'), retryAfterMs: null })
      .mockResolvedValueOnce({ data: operation('succeeded'), retryAfterMs: null })
    const sleep = vi.fn(async (_milliseconds: number) => {})

    const result = await pollMintOperation('op_1', get, { sleep })

    expect(result.status).toBe('succeeded')
    expect(get).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('stops at preview_ready for review operations', async () => {
    const get = vi.fn().mockResolvedValue({
      data: operation('preview_ready', 'review'),
      retryAfterMs: null,
    })
    const sleep = vi.fn(async (_milliseconds: number) => {})

    const result = await pollMintOperation('op_1', get, { sleep })

    expect(result.status).toBe('preview_ready')
    expect(get).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('model optimization reconciliation', () => {
  it('waits for a concurrent optimization to publish the optimized GLB', async () => {
    const unoptimized = {
      object: 'model',
      id: 'model_1',
      status: 'succeeded',
      assets: { optimizedGlbUrl: null },
    } as MintPluginModel
    const optimized = {
      ...unoptimized,
      assets: { optimizedGlbUrl: 'https://cdn.mint.gg/model_1-optimized.glb' },
    } as MintPluginModel
    const get = vi.fn()
      .mockResolvedValueOnce(unoptimized)
      .mockResolvedValueOnce(optimized)
    const sleep = vi.fn(async (_milliseconds: number) => {})

    await expect(
      pollMintModelUntilOptimized('model_1', get, { sleep }),
    ).resolves.toEqual(optimized)
    expect(get).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledOnce()
  })
})
