import { describe, expect, test } from 'vitest'
import {
  hasCreditsForEstimate,
  operationErrorLabel,
  operationErrorReport,
  operationIsAwaitingReview,
  type MintOperation,
} from './types'

describe('hasCreditsForEstimate', () => {
  const estimate = {
    object: 'pricing_estimate' as const,
    operation: 'model_optimization',
    credits: { requiredToStart: 20, estimatedTotal: 20 },
  }

  test('allows an operation when the required credits are available', () => {
    expect(
      hasCreditsForEstimate(
        { object: 'usage', credits: { totalAvailable: 20 } },
        estimate,
      ),
    ).toBe(true)
  })

  test('blocks an operation when the balance is below the required start amount', () => {
    expect(
      hasCreditsForEstimate(
        { object: 'usage', credits: { totalAvailable: 19 } },
        estimate,
      ),
    ).toBe(false)
  })

  test('blocks until both usage and pricing are known', () => {
    expect(hasCreditsForEstimate(null, estimate)).toBe(false)
    expect(
      hasCreditsForEstimate(
        { object: 'usage', credits: { totalAvailable: 100 } },
        null,
      ),
    ).toBe(false)
  })
})

describe('operation review state', () => {
  const previewOperation: MintOperation = {
    object: 'operation',
    id: 'op_preview',
    type: 'model_generation',
    generationMode: 'auto',
    status: 'preview_ready',
    resource: { type: 'model', id: 'model_1' },
    createdAt: '2026-08-03T22:46:00.000Z',
    updatedAt: '2026-08-03T22:47:00.000Z',
  }

  test('requires a review decision only in review mode', () => {
    expect(operationIsAwaitingReview(previewOperation)).toBe(false)
    expect(operationIsAwaitingReview({
      ...previewOperation,
      generationMode: 'review',
    })).toBe(true)
  })
})

describe('operation error reporting', () => {
  const failedOperation: MintOperation = {
    object: 'operation',
    id: 'w176p1b19kz0bbdd0pym95qga58bs4fh',
    type: 'model_generation',
    generationMode: 'auto',
    status: 'failed',
    resource: { type: 'model', id: 'model_1' },
    error: {
      code: 'transient_generation_failure',
      message: 'Mint hit a temporary generation issue before the asset completed. Retry this generation.',
    },
    createdAt: '2026-08-03T22:46:00.000Z',
    updatedAt: '2026-08-03T22:47:00.000Z',
  }

  test('presents a user-friendly label and copyable support details', () => {
    expect(operationErrorLabel(failedOperation)).toBe('Temporary service issue')
    expect(operationErrorReport(failedOperation)).toBe(
      [
        'Mint error: transient_generation_failure',
        'Operation: w176p1b19kz0bbdd0pym95qga58bs4fh',
        'Message: Mint hit a temporary generation issue before the asset completed. Retry this generation.',
      ].join('\n'),
    )
  })

  test('does not copy malformed server error codes', () => {
    const malformed = {
      ...failedOperation,
      error: { code: '<script>', message: 'Operation failed.' },
    }
    expect(operationErrorLabel(malformed)).toBeNull()
    expect(operationErrorReport(malformed)).toBeNull()
  })
})
