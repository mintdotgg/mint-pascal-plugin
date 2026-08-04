export type Vec3 = [number, number, number]

export type GlbBounds = {
  min: Vec3
  max: Vec3
  size: Vec3
  center: Vec3
}

export type MintPluginUser = {
  walletAddress: string
  email: string | null
}

export type MintPluginSession =
  | { connected: false }
  | {
      connected: true
      user: MintPluginUser
      scopes: string[]
    }

export type MintModelAssets = {
  fbxUrl: string | null
  glbUrl: string | null
  glbSizeBytes: number | null
  objUrl: string | null
  optimizedGlbUrl: string | null
  optimizedGlbSizeBytes: number | null
  previewImageUrl: string | null
  stlUrl: string | null
  thumbnailUrl: string | null
  usdzUrl: string | null
  bounds: GlbBounds | null
}

export type MintPluginModel = {
  object: 'model'
  id: string
  name: string | null
  prompt: string | null
  status: string | null
  assetStage: 'preview' | 'final' | null
  mintUrl: string
  assets: MintModelAssets | null
  createdAt: string | null
  updatedAt: string | null
}

export type MintPluginModelPage = {
  data: MintPluginModel[]
  pagination: { nextCursor: string | null; hasMore: boolean }
}

export type MintGenerationPreset = 'fast' | 'standard' | 'production'
export type MintGenerationMode = 'auto' | 'review'
export type MintRiggingPose = 't_pose' | 'a_pose'

export type MintModelGenerationRequest = {
  prompt: string
  name?: string
  generationPreset: MintGenerationPreset
  generationMode: MintGenerationMode
  riggingPose?: MintRiggingPose
  imageUrl?: string
  sourceImages?: string[]
}

export type MintOperationStatus =
  | 'queued'
  | 'running'
  | 'preview_ready'
  | 'billing_required'
  | 'succeeded'
  | 'partially_succeeded'
  | 'failed'
  | 'canceled'

export type MintOperation = {
  object: 'operation'
  id: string
  type: string
  generationMode: MintGenerationMode
  status: MintOperationStatus
  resource: { type: string; id: string } | null
  assets?: MintModelAssets | null
  billing?: {
    reason: string
    requiredCredits: number
    availableCredits?: number
    actionUrl: string
  }
  credits?: {
    estimated: number | null
    reserved: number
    finalized: number
    availableAfterReservation: number | null
  }
  error?: { code: string; message: string }
  createdAt: string
  updatedAt: string
}

export function operationIsAwaitingReview(operation: MintOperation) {
  return operation.generationMode === 'review' && operation.status === 'preview_ready'
}

const OPERATION_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{1,79}$/

const OPERATION_ERROR_LABELS: Readonly<Record<string, string>> = {
  generation_interrupted: 'Generation interrupted',
  transient_generation_failure: 'Temporary service issue',
  moderation_blocked: 'Safety policy',
  quota_blocked: 'Credits unavailable',
  invalid_generation_input: 'Invalid input',
  generation_failed: 'Generation failed',
  start_failed: 'Start failed',
  optimization_not_started: 'Optimization unavailable',
  optimization_failed: 'Optimization failed',
}

export function operationErrorLabel(operation: MintOperation) {
  const code = operation.error?.code
  if (!code || !OPERATION_ERROR_CODE_PATTERN.test(code)) return null
  return OPERATION_ERROR_LABELS[code] ?? 'Generation error'
}

export function operationErrorReport(operation: MintOperation) {
  const code = operation.error?.code
  if (!code || !OPERATION_ERROR_CODE_PATTERN.test(code)) return null
  return [
    `Mint error: ${code}`,
    `Operation: ${operation.id}`,
    ...(operation.error?.message ? [`Message: ${operation.error.message}`] : []),
  ].join('\n')
}

export type MintUsage = {
  object: 'usage'
  credits: { totalAvailable: number }
}

export type MintPricingEstimate = {
  object: 'pricing_estimate'
  operation: string
  credits: { requiredToStart: number; estimatedTotal: number }
}

export function hasCreditsForEstimate(
  usage: MintUsage | null,
  estimate: MintPricingEstimate | null,
) {
  return Boolean(
    usage &&
      estimate &&
      usage.credits.totalAvailable >= estimate.credits.requiredToStart,
  )
}

export type MintReferenceImage = {
  id: string
  type: 'reference_image'
  url?: string | null
  assets?: { sourceUrl?: string | null; imageUrl?: string | null } | null
  sourceUrl?: string | null
  imageUrl?: string | null
}

export function optimizedGlbUrl(model: MintPluginModel) {
  return model.assets?.optimizedGlbUrl ?? null
}

export function placementGlbUrl(model: MintPluginModel) {
  return optimizedGlbUrl(model) ?? model.assets?.glbUrl ?? null
}

export function modelThumbnailUrl(model: MintPluginModel) {
  return model.assets?.thumbnailUrl ?? model.assets?.previewImageUrl ?? null
}

export function modelIsPlaceable(model: MintPluginModel) {
  return model.status === 'succeeded' && Boolean(placementGlbUrl(model))
}

export function modelIsOptimized(model: MintPluginModel) {
  return model.status === 'succeeded' && Boolean(optimizedGlbUrl(model))
}

type CompleteGeneratedModelInput = {
  completed: MintOperation
  optimizeAfterGeneration: boolean
  clearOptimizeAfterGeneration: () => void
  getModel: (modelId: string) => Promise<MintPluginModel>
  refreshModels: () => Promise<void>
  startOptimization: (modelId: string) => Promise<MintOperation>
  watchOperation: (operation: MintOperation) => Promise<MintOperation>
}

export async function completeGeneratedModelOperation(
  input: CompleteGeneratedModelInput,
) {
  const succeeded =
    input.completed.status === 'succeeded' ||
    input.completed.status === 'partially_succeeded'
  if (!succeeded) {
    if (input.completed.status === 'canceled') {
      input.clearOptimizeAfterGeneration()
    }
    return input.completed
  }

  if (input.completed.resource?.type !== 'model') {
    input.clearOptimizeAfterGeneration()
    return input.completed
  }

  await input.refreshModels()
  if (!input.optimizeAfterGeneration) {
    input.clearOptimizeAfterGeneration()
    return input.completed
  }

  const model = await input.getModel(input.completed.resource.id)
  if (!modelIsPlaceable(model) || modelIsOptimized(model)) {
    input.clearOptimizeAfterGeneration()
    return input.completed
  }

  const optimization = await input.startOptimization(model.id)
  input.clearOptimizeAfterGeneration()
  const optimized = await input.watchOperation(optimization)
  if (optimized.status === 'succeeded' || optimized.status === 'partially_succeeded') {
    await input.refreshModels()
  }
  return optimized
}
