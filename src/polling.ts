import type { MintApiResult } from './api'
import type { MintOperation } from './types'
import { operationIsAwaitingReview } from './types'

const TERMINAL_STATUSES = new Set([
  'billing_required',
  'succeeded',
  'partially_succeeded',
  'failed',
  'canceled',
])

export type PollOperationOptions = {
  signal?: AbortSignal
  initialDelayMs?: number
  multiplier?: number
  maxDelayMs?: number
  timeoutMs?: number
  now?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  onUpdate?: (operation: MintOperation) => void
}

export function operationNeedsPolling(operation: MintOperation) {
  if (operation.status === 'preview_ready') {
    return !operationIsAwaitingReview(operation)
  }
  return !TERMINAL_STATUSES.has(operation.status)
}

export async function pollMintOperation(
  operationId: string,
  getOperation: (operationId: string) => Promise<MintApiResult<MintOperation>>,
  options: PollOperationOptions = {},
) {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000
  const multiplier = options.multiplier ?? 1.6
  const maxDelayMs = options.maxDelayMs ?? 15_000
  const sleep = options.sleep ?? sleepWithSignal
  const startedAt = now()
  let delayMs = options.initialDelayMs ?? 2_000

  for (;;) {
    if (options.signal?.aborted) throw abortError()
    const result = await getOperation(operationId)
    options.onUpdate?.(result.data)
    if (!operationNeedsPolling(result.data)) return result.data
    if (now() - startedAt >= timeoutMs) {
      throw new Error('Mint generation is still running after 30 minutes. You can reconnect later.')
    }
    const waitMs = Math.min(maxDelayMs, result.retryAfterMs ?? delayMs)
    await sleep(waitMs, options.signal)
    delayMs = Math.min(maxDelayMs, Math.ceil(delayMs * multiplier))
  }
}

function abortError() {
  return new DOMException('Polling was canceled.', 'AbortError')
}

async function sleepWithSignal(milliseconds: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortError())
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}
