import type {
  MintModelGenerationRequest,
  MintOperation,
  MintPluginModel,
  MintPluginModelPage,
  MintPluginSession,
  MintPricingEstimate,
  MintReferenceImage,
  MintUsage,
} from './types'

const API_ROOT = '/api/plugins/mint'

export class MintPluginApiError extends Error {
  status: number
  retryAfterMs: number | null
  problemType: string | null

  constructor(message: string, response: Response, problemType: string | null) {
    super(message)
    this.name = 'MintPluginApiError'
    this.status = response.status
    this.retryAfterMs = retryAfterMs(response.headers.get('retry-after'))
    this.problemType = problemType
  }
}

const RECONCILABLE_OPTIMIZATION_PROBLEMS = [
  'model-already-optimized',
  'model-optimization-in-progress',
] as const

export function isMintOptimizationConflict(error: unknown) {
  if (!(error instanceof MintPluginApiError) || error.status !== 409) return false
  return RECONCILABLE_OPTIMIZATION_PROBLEMS.some((problem) =>
    error.problemType === problem || error.problemType?.endsWith(`/${problem}`),
  )
}

export type MintApiResult<T> = { data: T; retryAfterMs: number | null }

function retryAfterMs(value: string | null) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

async function parseResponse<T>(response: Response): Promise<MintApiResult<T>> {
  const value = await response.json().catch(() => null)
  if (!response.ok) {
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
    throw new MintPluginApiError(
      typeof record?.detail === 'string'
        ? record.detail
        : typeof record?.error_description === 'string'
          ? record.error_description
          : `Mint request failed (${response.status}).`,
      response,
      typeof record?.type === 'string' ? record.type : null,
    )
  }
  return { data: value as T, retryAfterMs: retryAfterMs(response.headers.get('retry-after')) }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  idempotencyKey?: string,
): Promise<MintApiResult<T>> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)
  return await parseResponse<T>(
    await fetch(`${API_ROOT}/${path.replace(/^\//, '')}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  )
}

function jsonBody(value: unknown) {
  return JSON.stringify(value)
}

export function mintConnectUrl(returnTo = window.location.pathname + window.location.search) {
  const params = new URLSearchParams({ returnTo })
  return `${API_ROOT}/oauth/start?${params}`
}

export async function getMintSession() {
  return (await request<MintPluginSession>('session')).data
}

export async function logoutMint() {
  await request<Record<string, never>>('logout', { method: 'POST', body: '{}' })
}

export async function listMintModels(cursor?: string | null, limit = 30) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  return (await request<MintPluginModelPage>(`api/models?${params}`)).data
}

export async function getMintModel(modelId: string) {
  return (await request<MintPluginModel>(`api/models/${encodeURIComponent(modelId)}`)).data
}

export async function getMintUsage() {
  return (await request<MintUsage>('api/usage')).data
}

export async function estimateModelGeneration(input: {
  generationPreset: MintModelGenerationRequest['generationPreset']
  generationMode: MintModelGenerationRequest['generationMode']
}) {
  return (
    await request<MintPricingEstimate>('api/pricing:estimate', {
      method: 'POST',
      body: jsonBody({ operation: 'model_generation', ...input }),
    })
  ).data
}

export async function estimateModelOptimization(modelId: string) {
  return (
    await request<MintPricingEstimate>('api/pricing:estimate', {
      method: 'POST',
      body: jsonBody({ operation: 'model_optimization', modelId }),
    })
  ).data
}

export async function uploadReferenceImage(
  input:
    | { base64Data: string; fileName: string; contentType: string; name?: string }
    | { sourceUrl: string; fileName?: string; name?: string },
  idempotencyKey: string,
) {
  return (
    await request<MintReferenceImage>(
      'api/reference-images',
      { method: 'POST', body: jsonBody(input) },
      idempotencyKey,
    )
  ).data
}

export async function generateMintModel(
  input: MintModelGenerationRequest,
  idempotencyKey: string,
) {
  return (
    await request<MintOperation>(
      'api/models:generate',
      { method: 'POST', body: jsonBody(input) },
      idempotencyKey,
    )
  ).data
}

export async function getMintOperation(operationId: string) {
  return await request<MintOperation>(`api/operations/${encodeURIComponent(operationId)}`)
}

export async function approveMintOperation(operationId: string, idempotencyKey: string) {
  return (
    await request<MintOperation>(
      `api/operations/${encodeURIComponent(operationId)}:approve`,
      { method: 'POST', body: '{}' },
      idempotencyKey,
    )
  ).data
}

export async function reviseMintOperation(
  operationId: string,
  feedback: string,
  idempotencyKey: string,
) {
  return (
    await request<MintOperation>(
      `api/operations/${encodeURIComponent(operationId)}:revise`,
      { method: 'POST', body: jsonBody({ feedback }) },
      idempotencyKey,
    )
  ).data
}

export async function resumeMintOperation(operationId: string, idempotencyKey: string) {
  return (
    await request<MintOperation>(
      `api/operations/${encodeURIComponent(operationId)}:resume`,
      { method: 'POST', body: '{}' },
      idempotencyKey,
    )
  ).data
}

export async function retryMintModel(modelId: string, idempotencyKey: string) {
  return (
    await request<MintOperation>(
      `api/models/${encodeURIComponent(modelId)}:retry`,
      { method: 'POST', body: '{}' },
      idempotencyKey,
    )
  ).data
}

export async function optimizeMintModel(modelId: string, idempotencyKey: string) {
  return (
    await request<MintOperation>(
      `api/models/${encodeURIComponent(modelId)}:optimize`,
      { method: 'POST', body: jsonBody({ optimizationLevel: 'moderate' }) },
      idempotencyKey,
    )
  ).data
}

export function newIdempotencyKey(action: string) {
  return `pascal-${action}-${crypto.randomUUID()}`
}

export async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}
