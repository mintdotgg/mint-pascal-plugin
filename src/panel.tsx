'use client'

import { useEditor } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  approveMintOperation,
  fileToBase64,
  generateMintModel,
  getMintModel,
  getMintOperation,
  getMintSession,
  isMintOptimizationConflict,
  listMintModels,
  logoutMint,
  MintPluginApiError,
  mintConnectUrl,
  newIdempotencyKey,
  optimizeMintModel,
  resumeMintOperation,
  retryMintModel,
  reviseMintOperation,
  uploadReferenceImage,
} from './api'
import { boundsCacheKey, readCachedBounds, writeCachedBounds } from './bounds-cache'
import MINT_PLUGIN_HERO from './assets/mint-pascal-hero.jpg'
import { MINT_THUMBNAIL_FALLBACK } from './mapping'
import { inspectGlb, measureGlbBounds, type GlbMetrics } from './measure-bounds'
import { armMintAssetForPlacement } from './placement'
import {
  operationNeedsPolling,
  pollMintModelUntilOptimized,
  pollMintOperation,
} from './polling'
import { MINT_PASCAL_PLUGIN_VERSION } from './version'
import type {
  GlbBounds,
  MintGenerationMode,
  MintGenerationPreset,
  MintOperation,
  MintPluginModel,
  MintPluginUser,
  MintRiggingPose,
} from './types'
import {
  completeGeneratedModelOperation,
  modelIsOptimized,
  modelIsPlaceable,
  modelThumbnailUrl,
  operationErrorReport,
  operationIsAwaitingReview,
  placementGlbUrl,
} from './types'

const PENDING_OPERATION_KEY = 'mint-pascal-pending-operation'
const PENDING_CREATE_TASKS_KEY = 'mint-pascal-pending-create-tasks'
const OPTIMIZE_AFTER_GENERATION_KEY = 'mint-pascal-optimize-after-generation'

type ConnectionState = 'loading' | 'disconnected' | 'connected' | 'expired' | 'error'
type Tab = 'create' | 'assets'
type PlacementProgress = {
  modelId: string
  modelName: string
  phase: 'optimizing' | 'preparing' | 'no_credits' | 'failed'
  message?: string
}
type CreateTask = {
  id: string
  operation: MintOperation
  optimizeAfterGeneration: boolean
}
type RememberedCreateTask = {
  id: string
  operationId: string
  optimizeAfterGeneration: boolean
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : 'Mint could not complete that request.'
}

function isUnauthorized(error: unknown) {
  return error instanceof MintPluginApiError && error.status === 401
}

function referenceUrl(reference: { url?: string | null; sourceUrl?: string | null; imageUrl?: string | null }) {
  return reference.url ?? reference.sourceUrl ?? reference.imageUrl ?? null
}

function publicReferenceImageUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:') throw new Error()
    return url.toString()
  } catch {
    throw new Error('Enter a valid public HTTPS image URL.')
  }
}

function accountDisplayName(user: MintPluginUser) {
  const localPart = user.email?.split('@')[0]?.split('+')[0]
  const words = localPart?.split(/[._-]+/).filter(Boolean) ?? []
  if (words.length > 0) {
    return words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }
  return user.walletAddress.length > 12
    ? `${user.walletAddress.slice(0, 6)}…${user.walletAddress.slice(-4)}`
    : user.walletAddress
}

function operationSucceeded(
  operation: MintOperation | null | undefined,
): boolean {
  return operation?.status === 'succeeded' || operation?.status === 'partially_succeeded'
}

function rememberOperation(operation: MintOperation | null) {
  if (typeof sessionStorage === 'undefined') return
  if (!operation) sessionStorage.removeItem(PENDING_OPERATION_KEY)
  else {
    sessionStorage.setItem(
      PENDING_OPERATION_KEY,
      JSON.stringify({ id: operation.id, type: operation.type, status: operation.status }),
    )
  }
}

function rememberedOperationId() {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_OPERATION_KEY) ?? 'null') as unknown
    return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
      ? (value as { id: string }).id
      : null
  } catch {
    return null
  }
}

function rememberCreateTasks(tasks: CreateTask[]) {
  if (typeof sessionStorage === 'undefined') return
  const resumableTasks = tasks.filter((task) => operationNeedsPolling(task.operation))
  if (resumableTasks.length === 0) {
    sessionStorage.removeItem(PENDING_CREATE_TASKS_KEY)
    return
  }
  sessionStorage.setItem(
    PENDING_CREATE_TASKS_KEY,
    JSON.stringify(resumableTasks.map((task) => ({
      id: task.id,
      operationId: task.operation.id,
      optimizeAfterGeneration: task.optimizeAfterGeneration,
    }))),
  )
}

function rememberedCreateTasks(): RememberedCreateTask[] {
  if (typeof sessionStorage === 'undefined') return []
  try {
    const value = JSON.parse(
      sessionStorage.getItem(PENDING_CREATE_TASKS_KEY) ?? '[]',
    ) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const candidate = item as Record<string, unknown>
      if (
        typeof candidate.id !== 'string' ||
        typeof candidate.operationId !== 'string' ||
        typeof candidate.optimizeAfterGeneration !== 'boolean'
      ) {
        return []
      }
      return [{
        id: candidate.id,
        operationId: candidate.operationId,
        optimizeAfterGeneration: candidate.optimizeAfterGeneration,
      }]
    })
  } catch {
    return []
  }
}

function rememberOptimizeAfterGeneration(enabled: boolean) {
  if (typeof sessionStorage === 'undefined') return
  if (enabled) sessionStorage.setItem(OPTIMIZE_AFTER_GENERATION_KEY, 'true')
  else sessionStorage.removeItem(OPTIMIZE_AFTER_GENERATION_KEY)
}

function rememberedOptimizeAfterGeneration() {
  return typeof sessionStorage !== 'undefined' &&
    sessionStorage.getItem(OPTIMIZE_AFTER_GENERATION_KEY) === 'true'
}

export default function MintAssetsPanel() {
  const [connection, setConnection] = useState<ConnectionState>('loading')
  const [user, setUser] = useState<MintPluginUser | null>(null)
  const [tab, setTab] = useState<Tab>('create')
  const [models, setModels] = useState<MintPluginModel[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [placingModelId, setPlacingModelId] = useState<string | null>(null)
  const [placementProgress, setPlacementProgress] = useState<PlacementProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [operation, setOperation] = useState<MintOperation | null>(null)
  const [createTasks, setCreateTasks] = useState<CreateTask[]>([])
  const [operationBusy, setOperationBusy] = useState(false)
  const [showLogoutDialog, setShowLogoutDialog] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const alive = useRef(true)

  const selectedModel = selectedModelId
    ? models.find((model) => model.id === selectedModelId) ?? null
    : null

  const updateOperation = useCallback((next: MintOperation) => {
    if (!alive.current) return
    setOperation(next)
    rememberOperation(next)
  }, [])

  const watchOperation = useCallback(
    async (next: MintOperation) => {
      updateOperation(next)
      if (operationNeedsPolling(next)) {
        return await pollMintOperation(next.id, getMintOperation, { onUpdate: updateOperation })
      }
      return next
    },
    [updateOperation],
  )

  const updateCreateTask = useCallback((
    taskId: string,
    next: MintOperation,
    optimizeAfterGeneration: boolean,
  ) => {
    if (!alive.current) return
    setCreateTasks((current) => {
      const task = { id: taskId, operation: next, optimizeAfterGeneration }
      const index = current.findIndex((candidate) => candidate.id === taskId)
      const updated = index === -1
        ? [...current, task]
        : current.map((candidate) => candidate.id === taskId ? task : candidate)
      rememberCreateTasks(updated)
      return updated
    })
  }, [])

  const removeCreateTask = useCallback((taskId: string) => {
    if (!alive.current) return
    setCreateTasks((current) => {
      const updated = current.filter((task) => task.id !== taskId)
      rememberCreateTasks(updated)
      return updated
    })
  }, [])

  const clearCompletedCreateTasks = useCallback(() => {
    setCreateTasks((current) => {
      const updated = current.filter((task) => !operationSucceeded(task.operation))
      rememberCreateTasks(updated)
      return updated
    })
  }, [])

  const watchCreateTaskOperation = useCallback(async (
    taskId: string,
    next: MintOperation,
    optimizeAfterGeneration: boolean,
  ) => {
    const update = (updated: MintOperation) => {
      updateCreateTask(taskId, updated, optimizeAfterGeneration)
    }
    update(next)
    if (operationNeedsPolling(next)) {
      return await pollMintOperation(next.id, getMintOperation, { onUpdate: update })
    }
    return next
  }, [updateCreateTask])

  const loadModels = useCallback(async (cursor?: string | null) => {
    setLoadingModels(true)
    try {
      const page = await listMintModels(cursor)
      const succeeded = page.data.filter((model) => model.status === 'succeeded')
      setModels((current) => {
        const source = cursor ? current : []
        const byId = new Map(source.map((model) => [model.id, model]))
        for (const model of succeeded) byId.set(model.id, model)
        return Array.from(byId.values())
      })
      setNextCursor(page.pagination.nextCursor)
    } catch (requestError) {
      if (isUnauthorized(requestError)) setConnection('expired')
      else setError(messageFrom(requestError))
    } finally {
      setLoadingModels(false)
    }
  }, [])

  const completeGeneratedModel = useCallback(async (
    completed: MintOperation,
    optimizeAfterGeneration: boolean,
    options?: {
      clearOptimizeAfterGeneration?: () => void
      watchOperation?: (operation: MintOperation) => Promise<MintOperation>
    },
  ) => await completeGeneratedModelOperation({
    completed,
    optimizeAfterGeneration,
    clearOptimizeAfterGeneration:
      options?.clearOptimizeAfterGeneration ??
      (() => rememberOptimizeAfterGeneration(false)),
    getModel: getMintModel,
    refreshModels: async () => await loadModels(),
    startOptimization: async (modelId) => await optimizeMintModel(
      modelId,
      newIdempotencyKey('optimize-after-generation'),
    ),
    watchOperation: options?.watchOperation ?? watchOperation,
  }), [loadModels, watchOperation])

  const runCreateTask = useCallback(async (
    taskId: string,
    initial: MintOperation,
    optimizeAfterGeneration: boolean,
  ) => {
    try {
      let completed = await watchCreateTaskOperation(
        taskId,
        initial,
        optimizeAfterGeneration,
      )
      if (initial.type === 'model_generation') {
        completed = await completeGeneratedModel(
          completed,
          optimizeAfterGeneration,
          {
            clearOptimizeAfterGeneration: () => undefined,
            watchOperation: async (next) => await watchCreateTaskOperation(
              taskId,
              next,
              optimizeAfterGeneration,
            ),
          },
        )
      } else if (
        completed.status === 'succeeded' ||
        completed.status === 'partially_succeeded'
      ) {
        await loadModels()
      }

      if (!operationSucceeded(completed)) removeCreateTask(taskId)
      rememberOptimizeAfterGeneration(
        completed.type === 'model_generation' && optimizeAfterGeneration,
      )
      updateOperation(completed)
    } catch (requestError) {
      removeCreateTask(taskId)
      setError(messageFrom(requestError))
    }
  }, [
    completeGeneratedModel,
    loadModels,
    removeCreateTask,
    updateOperation,
    watchCreateTaskOperation,
  ])

  useEffect(() => {
    alive.current = true
    void (async () => {
      setConnection('loading')
      try {
        const session = await getMintSession()
        if (!session.connected) {
          setConnection('disconnected')
          return
        }
        setUser(session.user)
        setConnection('connected')
        await loadModels()
        for (const task of rememberedCreateTasks()) {
          void getMintOperation(task.operationId)
            .then(async ({ data }) => await runCreateTask(
              task.id,
              data,
              task.optimizeAfterGeneration,
            ))
            .catch((requestError) => {
              removeCreateTask(task.id)
              setError(messageFrom(requestError))
            })
        }
        const pendingId = rememberedOperationId()
        if (pendingId) {
          const pending = (await getMintOperation(pendingId)).data
          const completed = await watchOperation(pending)
          if (pending.type === 'model_generation') {
            await completeGeneratedModel(
              completed,
              rememberedOptimizeAfterGeneration(),
            )
          }
        }
      } catch (requestError) {
        setConnection(isUnauthorized(requestError) ? 'expired' : 'error')
        setError(isUnauthorized(requestError) ? null : messageFrom(requestError))
      }
    })()
    return () => {
      alive.current = false
    }
  }, [
    completeGeneratedModel,
    loadModels,
    removeCreateTask,
    runCreateTask,
    watchOperation,
  ])

  useEffect(() => {
    if (!operation || !operationSucceeded(operation)) return
    const completedOperationId = operation.id
    const timeout = window.setTimeout(() => {
      setOperation((current) => {
        if (current?.id !== completedOperationId || !operationSucceeded(current)) {
          return current
        }
        rememberOperation(null)
        return null
      })
    }, 4_000)
    return () => window.clearTimeout(timeout)
  }, [operation])

  useEffect(() => {
    if (
      placementProgress?.phase !== 'no_credits' &&
      placementProgress?.phase !== 'failed'
    ) return
    const modelId = placementProgress.modelId
    const phase = placementProgress.phase
    const timeout = window.setTimeout(() => {
      setPlacementProgress((current) =>
        current?.modelId === modelId && current.phase === phase ? null : current,
      )
    }, 6_000)
    return () => window.clearTimeout(timeout)
  }, [placementProgress])

  async function resolveBounds(model: MintPluginModel): Promise<GlbBounds> {
    if (model.assets?.bounds) return model.assets.bounds
    const url = placementGlbUrl(model)
    if (!url) throw new Error('This model does not have a placement-ready GLB.')
    const key = boundsCacheKey(model.id, model.updatedAt)
    const cached = await readCachedBounds(key)
    if (cached) return cached
    const measured = await measureGlbBounds(url)
    await writeCachedBounds(key, measured)
    return measured
  }

  async function placeModel(model: MintPluginModel) {
    if (placingModelId || operationBusy) return
    const modelName = model.name ?? 'Untitled model'
    let optimizationStarted = false
    let modelToPlace = model
    setPlacingModelId(model.id)
    setError(null)
    try {
      if (!modelIsOptimized(modelToPlace)) {
        const refreshed = await getMintModel(model.id)
        setModels((current) =>
          current.map((currentModel) =>
            currentModel.id === refreshed.id ? refreshed : currentModel,
          ),
        )
        modelToPlace = refreshed
      }

      if (!modelIsPlaceable(modelToPlace)) {
        throw new Error('This model does not have a placement-ready GLB.')
      }

      if (!modelIsOptimized(modelToPlace)) {
        setPlacementProgress({ modelId: model.id, modelName, phase: 'optimizing' })
        optimizationStarted = true
        setOperationBusy(true)
        let completed: MintOperation | null = null
        try {
          completed = await watchOperation(
            await optimizeMintModel(model.id, newIdempotencyKey('optimize-after-place')),
          )
        } catch (optimizationError) {
          if (!isMintOptimizationConflict(optimizationError)) throw optimizationError
          const reconciled = await pollMintModelUntilOptimized(model.id, getMintModel)
          modelToPlace = reconciled
        }
        if (!completed) {
          setModels((current) =>
            current.map((currentModel) =>
              currentModel.id === modelToPlace.id ? modelToPlace : currentModel,
            ),
          )
        } else {
          if (completed.status === 'billing_required') {
            setPlacementProgress({
              modelId: model.id,
              modelName,
              phase: 'no_credits',
            })
            rememberOperation(null)
            setOperation(null)
            return
          }
          if (completed.status !== 'succeeded' && completed.status !== 'partially_succeeded') {
            throw new Error(completed.error?.message ?? 'Mint could not optimize this model.')
          }

          const refreshed = await getMintModel(model.id)
          if (!modelIsOptimized(refreshed)) {
            throw new Error('Mint finished optimization without returning an optimized GLB.')
          }
          setModels((current) =>
            current.map((currentModel) =>
              currentModel.id === refreshed.id ? refreshed : currentModel,
            ),
          )
          modelToPlace = refreshed
        }
        rememberOperation(null)
        setOperation(null)
      }

      setPlacementProgress({ modelId: model.id, modelName, phase: 'preparing' })
      armMintAssetForPlacement(modelToPlace, await resolveBounds(modelToPlace), {
        viewer: useViewer.getState(),
        editor: useEditor.getState(),
      })
      setPlacementProgress(null)
    } catch (placementError) {
      rememberOperation(null)
      setOperation(null)
      setPlacementProgress({
        modelId: model.id,
        modelName,
        phase: 'failed',
        message: messageFrom(placementError),
      })
    } finally {
      if (optimizationStarted) setOperationBusy(false)
      setPlacingModelId(null)
    }
  }

  async function performOperationAction(action: 'approve' | 'resume' | 'retry', feedback?: string) {
    if (!operation) return
    const operationType = operation.type
    const optimizeAfterGeneration =
      operationType === 'model_generation' && rememberedOptimizeAfterGeneration()
    setOperationBusy(true)
    setError(null)
    try {
      let next: MintOperation
      if (action === 'approve') {
        next = await approveMintOperation(operation.id, newIdempotencyKey('approve'))
      } else if (action === 'resume') {
        next = await resumeMintOperation(operation.id, newIdempotencyKey('resume'))
      } else if (operation.resource?.type === 'model') {
        next = await retryMintModel(operation.resource.id, newIdempotencyKey('retry'))
      } else {
        throw new Error('Mint has not attached a model to this operation yet.')
      }
      const completed = await watchOperation(next)
      if (operationType === 'model_generation') {
        await completeGeneratedModel(completed, optimizeAfterGeneration)
      } else if (
        (completed.status === 'succeeded' || completed.status === 'partially_succeeded') &&
        completed.resource?.type === 'model'
      ) {
        await loadModels()
      }
    } catch (requestError) {
      setError(messageFrom(requestError))
    } finally {
      setOperationBusy(false)
    }
    void feedback
  }

  async function revise(feedback: string) {
    if (!operation) return
    const operationType = operation.type
    const optimizeAfterGeneration =
      operationType === 'model_generation' && rememberedOptimizeAfterGeneration()
    setOperationBusy(true)
    setError(null)
    try {
      const completed = await watchOperation(
        await reviseMintOperation(operation.id, feedback, newIdempotencyKey('revise')),
      )
      if (operationType === 'model_generation') {
        await completeGeneratedModel(completed, optimizeAfterGeneration)
      }
    } catch (requestError) {
      setError(messageFrom(requestError))
    } finally {
      setOperationBusy(false)
    }
  }

  async function disconnect() {
    setLogoutBusy(true)
    setError(null)
    try {
      await logoutMint()
      rememberOperation(null)
      rememberCreateTasks([])
      rememberOptimizeAfterGeneration(false)
      setConnection('disconnected')
      setUser(null)
      setModels([])
      setSelectedModelId(null)
      setPlacementProgress(null)
      setOperation(null)
      setCreateTasks([])
    } catch (requestError) {
      setError(messageFrom(requestError))
    } finally {
      setShowLogoutDialog(false)
      setLogoutBusy(false)
    }
  }

  async function openCreatedModel(modelId: string) {
    setError(null)
    try {
      const model = await getMintModel(modelId)
      setModels((current) => [
        model,
        ...current.filter((candidate) => candidate.id !== model.id),
      ])
      clearCompletedCreateTasks()
      setSelectedModelId(modelId)
      setTab('assets')
    } catch (requestError) {
      setError(messageFrom(requestError))
    }
  }

  if (connection === 'loading') {
    return <PanelMessage title="Connecting to Mint…" body="Checking your secure Mint session." />
  }
  if (connection === 'disconnected' || connection === 'expired') {
    return (
      <PanelMessage
        emphasizeBody
        heroSrc={MINT_PLUGIN_HERO.src}
        title={connection === 'expired' ? 'Reconnect Mint' : 'Mint assets'}
        body={
          connection === 'expired'
            ? 'Your Mint session ended. Sign in again to continue.'
            : 'Generate, browse and add Mint 3D assets.'
        }
        action={
          <div className="flex w-full max-w-56 flex-col gap-2">
            <button
              className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold shadow-sm transition-opacity hover:opacity-90"
              onClick={() => window.location.assign(mintConnectUrl())}
              style={{ backgroundColor: '#bef93a', color: '#0a0a0a' }}
              type="button"
            >
              Sign In with Mint
            </button>
            <a
              className="w-full rounded-xl border border-sidebar-foreground/20 px-4 py-2.5 text-sm font-medium text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              href="https://mint.gg"
              rel="noreferrer"
              target="_blank"
            >
              Learn more about Mint
            </a>
          </div>
        }
      />
    )
  }
  if (connection === 'error') {
    return <PanelMessage title="Could not connect" body={error ?? 'Mint is temporarily unavailable.'} />
  }

  return (
    <div className="relative flex h-full flex-col text-sidebar-foreground">
      <header className="shrink-0 border-b border-sidebar-border/60 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <h2 className="font-semibold text-sm">Mint</h2>
            <span
              aria-label={`Mint Pascal Plugin version ${MINT_PASCAL_PLUGIN_VERSION}`}
              className="text-[9px] font-medium tabular-nums text-sidebar-foreground/35"
            >
              v{MINT_PASCAL_PLUGIN_VERSION}
            </span>
          </div>
          <button
            aria-label="Log out of Mint"
            className="flex size-8 items-center justify-center rounded-lg text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => setShowLogoutDialog(true)}
            title="Log out"
            type="button"
          >
            <LogoutIcon />
          </button>
        </div>
        <div
          aria-label="Mint panel sections"
          className="mt-3 grid grid-cols-2 gap-1 rounded-xl border border-sidebar-border bg-sidebar-accent p-1"
          role="tablist"
        >
          {(['create', 'assets'] as const).map((value) => (
            <button
              aria-controls="mint-tabpanel"
              aria-selected={tab === value}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${tab === value ? 'bg-sidebar text-sidebar-foreground shadow-sm' : 'text-sidebar-foreground/55 hover:text-sidebar-foreground'}`}
              id={`mint-tab-${value}`}
              key={value}
              onClick={() => {
                if (value !== tab) clearCompletedCreateTasks()
                setTab(value)
                if (value === 'create') setSelectedModelId(null)
              }}
              role="tab"
              type="button"
            >
              {value === 'create' ? 'Create' : 'Assets'}
            </button>
          ))}
        </div>
      </header>

      <div
        aria-labelledby={`mint-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto p-3"
        id="mint-tabpanel"
        role="tabpanel"
      >
        {tab === 'assets' ? (
          selectedModel ? (
            <ModelDetail
              busy={operationBusy || placingModelId !== null}
              model={selectedModel}
              onBack={() => setSelectedModelId(null)}
              onPlace={() => void placeModel(selectedModel)}
              progress={
                placementProgress?.modelId === selectedModel.id
                  ? placementProgress
                  : null
              }
              placing={placingModelId === selectedModel.id}
            />
          ) : (
            <Library
              busy={operationBusy || placingModelId !== null}
              loading={loadingModels}
              models={models}
              nextCursor={nextCursor}
              onLoadMore={() => void loadModels(nextCursor)}
              onOpen={(model) => setSelectedModelId(model.id)}
              onPlace={(model) => void placeModel(model)}
              placementProgress={placementProgress}
            />
          )
        ) : (
          <CreateModel
            currentTasks={createTasks}
            models={models}
            onError={setError}
            onOpenCompleted={(modelId) => void openCreatedModel(modelId)}
            onStarted={(next, optimizeAfterGeneration) => {
              void runCreateTask(next.id, next, optimizeAfterGeneration)
            }}
          />
        )}
      </div>

      {(error || (operation && !placementProgress)) && (
        <div aria-live="polite" className="shrink-0 space-y-2 p-3 pt-0">
          {error && <ErrorNotice detail={error} onDismiss={() => setError(null)} />}
          {operation && !placementProgress && (
            <OperationCard
              busy={operationBusy}
              onApprove={() => void performOperationAction('approve')}
              onDismiss={() => {
                rememberOperation(null)
                setOperation(null)
              }}
              onResume={() => void performOperationAction('resume')}
              onRetry={() => void performOperationAction('retry')}
              onRevise={(feedback) => void revise(feedback)}
              operation={operation}
            />
          )}
        </div>
      )}

      {showLogoutDialog && user && (
        <LogoutDialog
          accountName={accountDisplayName(user)}
          busy={logoutBusy}
          onCancel={() => setShowLogoutDialog(false)}
          onConfirm={() => void disconnect()}
        />
      )}
    </div>
  )
}

function Library(props: {
  models: MintPluginModel[]
  busy: boolean
  loading: boolean
  nextCursor: string | null
  onPlace: (model: MintPluginModel) => void
  onOpen: (model: MintPluginModel) => void
  onLoadMore: () => void
  placementProgress: PlacementProgress | null
}) {
  if (props.loading && props.models.length === 0) {
    return <PanelMessage title="Loading models…" body="Loading your newest succeeded 3D models." />
  }
  if (props.models.length === 0) {
    return <PanelMessage title="No succeeded models yet" body="Use Create to generate a model without leaving Pascal." />
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {props.models.map((model) => {
          const progress = props.placementProgress?.modelId === model.id
            ? props.placementProgress
            : null
          return (
            <article className="overflow-hidden rounded-xl border border-sidebar-border bg-sidebar-accent/30" key={model.id}>
              <div className="relative">
                <button
                  aria-label={`Add ${model.name ?? 'Untitled model'} to the scene`}
                  className="block w-full disabled:opacity-50"
                  disabled={props.busy}
                  onClick={() => props.onPlace(model)}
                  title="Add to scene"
                  type="button"
                >
                  <img
                    alt=""
                    className="aspect-square w-full bg-black/5 object-contain transition-opacity hover:opacity-90"
                    loading="lazy"
                    src={modelThumbnailUrl(model) ?? MINT_THUMBNAIL_FALLBACK}
                  />
                </button>
                {progress && <AssetPlacementProgress progress={progress} />}
                <button
                  aria-label={`View details for ${model.name ?? 'Untitled model'}`}
                  className="absolute z-10 flex size-6 items-center justify-center rounded-full border border-transparent text-white drop-shadow-sm transition-colors hover:border-white/25 hover:bg-black/70 focus-visible:border-white/25 focus-visible:bg-black/70"
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onOpen(model)
                  }}
                  style={{ right: '0.5rem', top: '0.5rem' }}
                  title="View details"
                  type="button"
                >
                  <InfoIcon />
                </button>
              </div>
              <button
                aria-label={`View details for ${model.name ?? 'Untitled model'}`}
                className="block w-full truncate px-2 py-2 text-left text-xs font-medium hover:bg-sidebar-accent/60"
                onClick={() => props.onOpen(model)}
                title="View details"
                type="button"
              >
                {model.name ?? 'Untitled model'}
              </button>
            </article>
          )
        })}
      </div>
      {props.nextCursor && (
        <button className="mt-3 w-full rounded-lg bg-sidebar-accent px-3 py-2 text-xs" disabled={props.loading} onClick={props.onLoadMore} type="button">
          {props.loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  )
}

function ModelDetail(props: {
  model: MintPluginModel
  busy: boolean
  placing: boolean
  onBack: () => void
  onPlace: () => void
  progress: PlacementProgress | null
}) {
  const optimized = modelIsOptimized(props.model)
  const sourceUrl = placementGlbUrl(props.model)
  const [metrics, setMetrics] = useState<GlbMetrics | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(Boolean(sourceUrl))
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setMetrics(null)
    setMetricsLoading(Boolean(sourceUrl))
    if (!sourceUrl) return () => { current = false }

    void inspectGlb(sourceUrl)
      .then((nextMetrics) => {
        if (current) setMetrics(nextMetrics)
      })
      .catch(() => undefined)
      .finally(() => {
        if (current) setMetricsLoading(false)
      })

    return () => { current = false }
  }, [sourceUrl])

  const knownFileSize = optimized
    ? props.model.assets?.optimizedGlbSizeBytes
    : props.model.assets?.glbSizeBytes
  const pendingValue = metricsLoading ? '…' : '—'

  return (
    <div className="space-y-5">
      <button
        className="rounded-md px-2 py-1 text-xs text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        onClick={props.onBack}
        type="button"
      >
        ← Assets
      </button>

      <div className="relative overflow-hidden rounded-xl border border-sidebar-border">
        <img
          alt={props.model.name ?? 'Mint model'}
          className="aspect-square w-full bg-black/5 object-contain"
          src={modelThumbnailUrl(props.model) ?? MINT_THUMBNAIL_FALLBACK}
        />
        {props.progress && <AssetPlacementProgress progress={props.progress} />}
      </div>

      <button
        className="w-full rounded-lg border border-sidebar-primary-foreground/25 bg-sidebar-primary px-3 py-2.5 text-xs font-medium text-sidebar-primary-foreground shadow-sm disabled:opacity-50"
        disabled={props.busy}
        onClick={props.onPlace}
        type="button"
      >
        {props.placing
          ? props.progress?.phase === 'optimizing'
            ? 'Optimizing…'
            : 'Preparing…'
          : 'Add to scene'}
      </button>

      <h2 className="text-base font-semibold leading-6">{props.model.name ?? 'Untitled model'}</h2>

      <section className="overflow-hidden rounded-xl border border-sidebar-border">
        <div className="flex items-center justify-between gap-3 border-b border-sidebar-border px-3.5 py-2.5">
          <h3 className="text-[10px] font-medium uppercase tracking-[0.18em] text-sidebar-foreground/45">Prompt</h3>
          <button
            className="rounded-md px-2 py-1 text-[11px] font-medium text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-40"
            disabled={!props.model.prompt}
            onClick={() => {
              if (!props.model.prompt) return
              void navigator.clipboard.writeText(props.model.prompt)
                .then(() => setCopiedPrompt(props.model.prompt))
                .catch(() => undefined)
            }}
            type="button"
          >
            {copiedPrompt === props.model.prompt ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="whitespace-pre-wrap px-3.5 py-3.5 text-[13px] leading-5 text-sidebar-foreground/70">
          {props.model.prompt ?? 'No prompt is available for this model.'}
        </p>
      </section>

      <section className="space-y-2.5">
        <h3 className="px-1 text-[10px] font-medium uppercase tracking-[0.18em] text-sidebar-foreground/45">Info</h3>
        <dl className="divide-y divide-sidebar-border overflow-hidden rounded-xl border border-sidebar-border bg-sidebar-accent/25">
          <ModelMetric
            label="Faces"
            value={metrics ? displayCount(metrics.faces) : pendingValue}
          />
          <ModelMetric
            label="Vertices"
            value={metrics ? displayCount(metrics.vertices) : pendingValue}
          />
          <ModelMetric
            label="File size"
            value={displayFileSize(metrics?.fileSizeBytes ?? knownFileSize) ?? pendingValue}
          />
          <div className="flex min-h-11 items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
            <dt className="text-sidebar-foreground/55">Mint link</dt>
            <dd>
              <a
                className="rounded-md px-2 py-1 text-[11px] font-medium text-sidebar-foreground/60 hover:bg-sidebar hover:text-sidebar-foreground"
                href={props.model.mintUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open in Mint
              </a>
            </dd>
          </div>
        </dl>
      </section>

    </div>
  )
}

function ModelMetric(props: { label: string; value: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
      <dt className="text-sidebar-foreground/55">{props.label}</dt>
      <dd className="truncate font-medium tabular-nums text-sidebar-foreground/85">{props.value}</dd>
    </div>
  )
}

function displayCount(value: number) {
  return new Intl.NumberFormat().format(value)
}

function displayFileSize(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 999.5 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: unitIndex === 0 || value >= 10 ? 0 : 1,
  })} ${units[unitIndex]}`
}

function CreateModel(props: {
  currentTasks: CreateTask[]
  models: MintPluginModel[]
  onError: (error: string | null) => void
  onOpenCompleted: (modelId: string) => void
  onStarted: (operation: MintOperation, optimizeAfterGeneration: boolean) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [preset, setPreset] = useState<MintGenerationPreset>('fast')
  const [mode, setMode] = useState<MintGenerationMode>('auto')
  const [rigging, setRigging] = useState<'none' | MintRiggingPose>('none')
  const [files, setFiles] = useState<File[]>([])
  const [referenceImageUrl, setReferenceImageUrl] = useState('')
  const [importedReferenceImage, setImportedReferenceImage] = useState<{
    sourceUrl: string
    url: string
  } | null>(null)
  const [importingReferenceImage, setImportingReferenceImage] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [optimizeAfterGeneration, setOptimizeAfterGeneration] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const hasPendingReferenceImageUrl = Boolean(referenceImageUrl.trim())
  const hasGenerationInput = Boolean(prompt.trim() || files.length > 0 || importedReferenceImage)
  const canAddFile = files.length + (importedReferenceImage ? 1 : 0) < 8
  const canImportReferenceImage = Boolean(importedReferenceImage) || files.length < 8

  async function importReferenceImage(value: string) {
    if (importingReferenceImage) return
    let sourceUrl: string | null
    try {
      sourceUrl = publicReferenceImageUrl(value)
    } catch (urlError) {
      props.onError(messageFrom(urlError))
      return
    }
    if (!sourceUrl) return

    setImportingReferenceImage(true)
    props.onError(null)
    try {
      const imported = await uploadReferenceImage(
        { sourceUrl },
        newIdempotencyKey('reference-url'),
      )
      const url = referenceUrl(imported)
      if (!url) throw new Error('Mint imported a reference image without returning its durable URL.')
      setImportedReferenceImage({ sourceUrl, url })
      setReferenceImageUrl('')
    } catch (requestError) {
      props.onError(messageFrom(requestError))
    } finally {
      setImportingReferenceImage(false)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (
      submitting ||
      importingReferenceImage ||
      hasPendingReferenceImageUrl ||
      !hasGenerationInput
    ) return
    setSubmitting(true)
    props.onError(null)
    try {
      if (files.length + (importedReferenceImage ? 1 : 0) > 8) {
        throw new Error('Use up to 8 reference images per generation.')
      }
      const urls: string[] = []
      for (const [index, file] of files.entries()) {
        const uploaded = await uploadReferenceImage(
          {
            base64Data: await fileToBase64(file),
            fileName: file.name,
            contentType: file.type || 'application/octet-stream',
          },
          newIdempotencyKey(`reference-${index}`),
        )
        const url = referenceUrl(uploaded)
        if (!url) throw new Error('Mint uploaded a reference image without returning its durable URL.')
        urls.push(url)
      }
      if (importedReferenceImage) urls.push(importedReferenceImage.url)
      const request = {
        prompt: prompt.trim() || 'Create a 3D model matching the uploaded reference image.',
        ...(name.trim() ? { name: name.trim() } : {}),
        generationPreset: preset,
        generationMode: mode,
        ...(rigging === 'none' ? {} : { riggingPose: rigging }),
        ...(urls.length === 1 ? { imageUrl: urls[0] } : {}),
        ...(urls.length >= 2 ? { sourceImages: urls } : {}),
      }
      const started = await generateMintModel(request, newIdempotencyKey('generate'))
      props.onStarted(started, optimizeAfterGeneration)
      setPrompt('')
      setName('')
      setFiles([])
      setReferenceImageUrl('')
      setImportedReferenceImage(null)
      if (imageInputRef.current) imageInputRef.current.value = ''
    } catch (requestError) {
      props.onError(messageFrom(requestError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="space-y-6" onSubmit={(event) => void submit(event)}>
      <h2 className="text-base font-semibold leading-6">
        What would you like to create?
      </h2>

      <label className="flex flex-col text-xs" style={{ gap: '0.5rem' }}>
        <span className="font-medium">Describe the 3D model</span>
        <textarea
          className="w-full rounded-xl border border-sidebar-border bg-sidebar p-3.5 leading-5 outline-none focus:ring-1"
          maxLength={8000}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="A warm Scandinavian lounge chair with rounded oak arms, cream bouclé cushions, and softly tapered legs"
          style={{ minHeight: '6.5rem' }}
          value={prompt}
        />
      </label>

      <div className="flex flex-col text-xs" style={{ gap: '0.5rem' }}>
        <span className="font-medium">Or upload a reference image</span>
        {(files.length > 0 || importedReferenceImage) && (
          <div className={files.length + (importedReferenceImage ? 1 : 0) === 1 ? 'grid grid-cols-1' : 'grid grid-cols-2 gap-2'}>
            {files.map((file, index) => (
              <ReferenceImagePreview
                file={file}
                key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                onRemove={() => {
                  setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))
                  if (imageInputRef.current) imageInputRef.current.value = ''
                }}
              />
            ))}
            {importedReferenceImage && (
              <ImportedReferenceImagePreview
                image={importedReferenceImage}
                onRemove={() => {
                  setImportedReferenceImage(null)
                  setReferenceImageUrl('')
                }}
              />
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label
            className={`flex min-h-11 items-center rounded-xl border border-sidebar-border bg-sidebar px-3.5 py-2.5 font-medium ${canAddFile ? 'cursor-pointer hover:bg-sidebar-accent/40' : 'cursor-not-allowed opacity-50'}`}
          >
            <span className="truncate">Upload image</span>
            <input
              accept="image/*"
              className="hidden"
              disabled={!canAddFile}
              multiple
              onChange={(event) => {
                const selected = Array.from(event.target.files ?? [])
                const availableSlots = Math.max(0, 8 - files.length - (importedReferenceImage ? 1 : 0))
                setFiles((current) => [...current, ...selected.slice(0, availableSlots)])
                event.currentTarget.value = ''
              }}
              ref={imageInputRef}
              type="file"
            />
          </label>
          <input
            aria-label="Reference image URL"
            className="min-w-0 rounded-xl border border-sidebar-border bg-sidebar px-3.5 py-2.5 outline-none placeholder:text-sidebar-foreground/40 focus:ring-1 disabled:opacity-50"
            disabled={importingReferenceImage || !canImportReferenceImage}
            inputMode="url"
            onChange={(event) => setReferenceImageUrl(event.target.value)}
            onBlur={() => void importReferenceImage(referenceImageUrl)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void importReferenceImage(referenceImageUrl)
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData('text').trim()
              if (!pasted) return
              event.preventDefault()
              setReferenceImageUrl(pasted)
              void importReferenceImage(pasted)
            }}
            placeholder={importingReferenceImage ? 'Processing image…' : 'Paste image URL'}
            type="url"
            value={importingReferenceImage ? '' : referenceImageUrl}
          />
        </div>
      </div>

      <details className="rounded-xl border border-sidebar-border">
        <summary className="cursor-pointer px-3.5 py-3 text-xs font-medium hover:bg-sidebar-accent/30">
          Advanced
        </summary>
        <div className="space-y-4 border-t border-sidebar-border p-3.5">
          <div className="space-y-2 text-xs">
            <FieldLabel
              description="Sets the name shown for this model in Mint and Pascal. Leave it blank to let Mint choose one."
              label="Name"
            />
            <input
              aria-label="Name"
              className="w-full rounded-lg border border-sidebar-border bg-sidebar p-2.5"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select description="Controls speed and detail. Fast is quickest, Standard is balanced, and Production prioritizes quality." label="Preset" onChange={(value) => setPreset(value as MintGenerationPreset)} value={preset} options={[['fast', 'Fast'], ['standard', 'Standard'], ['production', 'Production']]} />
            <Select description="Auto continues to the final model. Review pauses at the preview for approval or revision." label="Workflow" onChange={(value) => setMode(value as MintGenerationMode)} value={mode} options={[['auto', 'Auto'], ['review', 'Review preview']]} />
          </div>
          <Select description="Guides eligible characters into a neutral T-pose or A-pose for easier rigging." label="Character pose" onChange={(value) => setRigging(value as 'none' | MintRiggingPose)} value={rigging} options={[['none', 'None'], ['t_pose', 'T-pose'], ['a_pose', 'A-pose']]} />
          <div className="space-y-2 text-xs">
            <FieldLabel
              description="Runs optimization after generation so the model is ready to use efficiently in Pascal."
              label="Auto Optimize"
            />
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-sidebar-border bg-sidebar-accent/25 p-3.5">
              <input
                checked={optimizeAfterGeneration}
                className="mt-0.5 size-4 accent-current"
                onChange={(event) => setOptimizeAfterGeneration(event.target.checked)}
                type="checkbox"
              />
              <span className="leading-4 text-sidebar-foreground/55">
                Optimized automatically after generation for Pascal.
              </span>
            </label>
          </div>
        </div>
      </details>

      <button className="w-full rounded-xl border border-sidebar-primary-foreground/25 bg-sidebar-primary px-4 py-3 text-sm font-medium text-sidebar-primary-foreground shadow-sm disabled:opacity-50" disabled={submitting || importingReferenceImage || hasPendingReferenceImageUrl || !hasGenerationInput} type="submit">
        {submitting ? 'Starting…' : 'Generate 3D model'}
      </button>

      {props.currentTasks.length > 0 && (
        <section
          className="space-y-3 border-t border-sidebar-border/70"
          style={{ paddingTop: '1.25rem' }}
        >
          <h3 className="text-sm font-semibold">Currently creating</h3>
          <div className="space-y-2">
            {props.currentTasks.map((task) => (
              <CurrentWork
                key={task.id}
                model={
                  task.operation.resource?.type === 'model'
                    ? props.models.find((model) => model.id === task.operation.resource?.id) ?? null
                    : null
                }
                onOpen={
                  operationSucceeded(task.operation) &&
                  task.operation.resource?.type === 'model'
                    ? () => props.onOpenCompleted(task.operation.resource!.id)
                    : undefined
                }
                operation={task.operation}
              />
            ))}
          </div>
        </section>
      )}
    </form>
  )
}

function CurrentWork(props: {
  operation: MintOperation
  model: MintPluginModel | null
  onOpen?: () => void
}) {
  const thumbnail = props.model ? modelThumbnailUrl(props.model) : props.operation.assets?.previewImageUrl
  const optimizing = props.operation.type === 'model_optimization'
  const succeeded = operationSucceeded(props.operation)
  const displayStatus =
    succeeded
      ? 'succeeded'
      : props.operation.status === 'preview_ready' &&
    !operationIsAwaitingReview(props.operation)
        ? 'running'
        : props.operation.status
  const modelName = props.model?.name ?? '3D model'
  const title = succeeded
    ? optimizing
      ? `${modelName} optimized`
      : `${modelName} created`
    : optimizing
      ? `Optimizing ${modelName}`
      : 'Generating 3D model'

  const content = (
    <>
      {thumbnail ? (
        <img
          alt=""
          className="shrink-0 rounded-lg bg-black/5 object-cover"
          src={thumbnail}
          style={{ height: '2.5rem', width: '2.5rem' }}
        />
      ) : (
        <div
          className="flex shrink-0 items-center justify-center rounded-lg bg-sidebar-accent"
          style={{ height: '2.5rem', width: '2.5rem' }}
        >
          {succeeded ? <SuccessCheck /> : (
            <svg aria-hidden="true" className="size-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-80" d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
            </svg>
          )}
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="truncate text-xs font-medium">{title}</h3>
        <p className="text-[11px] capitalize text-sidebar-foreground/50">
          {displayStatus}
        </p>
      </div>
      {thumbnail && (
        succeeded ? <SuccessCheck /> : (
          <svg aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-sidebar-foreground/50" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-80" d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
          </svg>
        )
      )}
    </>
  )

  if (props.onOpen) {
    return (
      <button
        aria-label={`Open ${modelName} in Assets`}
        className="flex w-full items-center gap-3 rounded-xl border border-sidebar-border bg-sidebar-accent/25 p-3 text-left transition-colors hover:bg-sidebar-accent/45 focus-visible:outline-none focus-visible:ring-1"
        onClick={props.onOpen}
        type="button"
      >
        {content}
      </button>
    )
  }

  return (
    <section className="flex items-center gap-3 rounded-xl border border-sidebar-border bg-sidebar-accent/25 p-3" role="status">
      {content}
    </section>
  )
}

function SuccessCheck() {
  return (
    <svg
      aria-label="Succeeded"
      className="size-4 shrink-0"
      fill="none"
      role="img"
      style={{ color: '#22c55e' }}
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="m8 12 2.5 2.5L16 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  )
}

function ReferenceImagePreview(props: { file: File; onRemove: () => void }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(props.file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [props.file])

  return (
    <div className="relative overflow-hidden rounded-xl border border-sidebar-border bg-sidebar-accent/25" style={{ height: '5.5rem' }}>
      {previewUrl && (
        <img
          alt={props.file.name}
          className="size-full object-contain"
          src={previewUrl}
        />
      )}
      <button
        aria-label={`Remove ${props.file.name}`}
        className="absolute z-10 flex size-6 items-center justify-center rounded-full border border-white/20 bg-black/70 text-base leading-none text-white shadow-sm hover:bg-black/85"
        onClick={props.onRemove}
        style={{
          right: '0.5rem',
          top: '0.5rem',
          backgroundColor: 'rgba(0, 0, 0, 0.78)',
          borderColor: 'rgba(255, 255, 255, 0.35)',
          borderRadius: '9999px',
          boxShadow: '0 1px 5px rgba(0, 0, 0, 0.35)',
          color: '#fff',
          height: '1.5rem',
          width: '1.5rem',
        }}
        type="button"
      >
        ×
      </button>
    </div>
  )
}

function ImportedReferenceImagePreview(props: {
  image: { sourceUrl: string; url: string }
  onRemove: () => void
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-sidebar-border bg-sidebar-accent/25" style={{ height: '5.5rem' }}>
      <img
        alt="Imported reference"
        className="size-full object-contain"
        src={props.image.url}
      />
      <button
        aria-label="Remove imported reference image"
        className="absolute z-10 flex size-6 items-center justify-center rounded-full border border-white/20 bg-black/70 text-base leading-none text-white shadow-sm hover:bg-black/85"
        onClick={props.onRemove}
        style={{
          right: '0.5rem',
          top: '0.5rem',
          backgroundColor: 'rgba(0, 0, 0, 0.78)',
          borderColor: 'rgba(255, 255, 255, 0.35)',
          borderRadius: '9999px',
          boxShadow: '0 1px 5px rgba(0, 0, 0, 0.35)',
          color: '#fff',
          height: '1.5rem',
          width: '1.5rem',
        }}
        title={props.image.sourceUrl}
        type="button"
      >
        ×
      </button>
    </div>
  )
}

function FieldLabel(props: { label: string; description: string }) {
  return (
    <div className="relative flex w-full items-center gap-1.5">
      <span className="font-medium">{props.label}</span>
      <button
        aria-label={`${props.label}: ${props.description}`}
        className="peer flex size-4 shrink-0 items-center justify-center rounded-full border border-sidebar-foreground/25 text-[10px] font-semibold leading-none text-sidebar-foreground/55 hover:border-sidebar-foreground/50 hover:text-sidebar-foreground focus:border-sidebar-foreground/50 focus:text-sidebar-foreground focus:outline-none"
        title={props.description}
        type="button"
      >
        i
      </button>
      <span
        className="pointer-events-none invisible absolute left-0 top-full z-30 mt-2 w-full rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-2 text-[11px] font-normal leading-4 text-sidebar-foreground/75 opacity-0 shadow-lg transition-opacity peer-hover:visible peer-hover:opacity-100 peer-focus:visible peer-focus:opacity-100"
        role="tooltip"
      >
        {props.description}
      </span>
    </div>
  )
}

function Select(props: { label: string; description: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return (
    <div className="space-y-2 text-xs">
      <FieldLabel description={props.description} label={props.label} />
      <select aria-label={props.label} className="w-full rounded-lg border border-sidebar-border bg-sidebar p-2.5" onChange={(event) => props.onChange(event.target.value)} value={props.value}>
        {props.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
  )
}

function AssetPlacementProgress(props: { progress: PlacementProgress }) {
  const running =
    props.progress.phase === 'optimizing' ||
    props.progress.phase === 'preparing'
  const label =
    props.progress.phase === 'optimizing'
      ? 'Optimizing model…'
      : props.progress.phase === 'preparing'
        ? 'Adding to scene…'
        : props.progress.phase === 'no_credits'
          ? 'No credits available'
          : 'Optimization failed'

  return (
    <div
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center text-white"
      aria-label={`${label}: ${props.progress.modelName}`}
      role={running ? 'status' : 'alert'}
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.72)', zIndex: 5 }}
      title={props.progress.message}
    >
      {running ? (
        <svg aria-hidden="true" className="size-4 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-80" d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
        </svg>
      ) : (
        <svg aria-hidden="true" className="size-4 shrink-0" fill="none" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path d="M12 7.5v5M12 16.5h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        </svg>
      )}
      <p className="text-xs font-medium leading-4">{label}</p>
    </div>
  )
}

function OperationCard(props: {
  operation: MintOperation
  busy: boolean
  onApprove: () => void
  onRevise: (feedback: string) => void
  onResume: () => void
  onRetry: () => void
  onDismiss: () => void
}) {
  const [feedback, setFeedback] = useState('')
  const [copiedError, setCopiedError] = useState(false)
  const operation = props.operation
  const awaitingReview = operationIsAwaitingReview(operation)
  const displayStatus =
    operation.status === 'preview_ready' && !awaitingReview
      ? 'running'
      : operation.status
  const errorReport = operationErrorReport(operation)
  const errorMessage = operation.error?.message?.trim() ?? null
  const showErrorMessage = Boolean(
    errorMessage &&
      !/^(?:operation|generation|model generation) failed\.?$/i.test(errorMessage),
  )
  if (operationSucceeded(operation)) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar px-3 py-2 shadow-sm" role="status">
        <p className="min-w-0 flex-1 truncate text-xs font-medium">
          {operationResultMessage(operation)}
        </p>
      </div>
    )
  }
  if (operation.status === 'canceled') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar px-3 py-2 shadow-sm" role="status">
        <p className="min-w-0 flex-1 truncate text-xs font-medium">
          {operationResultMessage(operation)}
        </p>
        <button
          aria-label="Dismiss operation notice"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-base leading-none text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={props.onDismiss}
          type="button"
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <section
      className={`space-y-2 rounded-xl border bg-sidebar p-3 text-xs shadow-sm ${
        operation.status === 'failed' ? 'border-red-500/50' : 'border-sidebar-border'
      }`}
      role={operation.status === 'failed' ? 'alert' : 'status'}
    >
      <div className="flex items-center justify-between gap-2">
        <strong>
          {operationTypeLabel(operation)}
          {operation.status === 'failed' ? ' failed' : ''}
        </strong>
        {operation.status === 'failed' && errorReport ? (
          <button
            className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => {
              void navigator.clipboard.writeText(errorReport)
                .then(() => setCopiedError(true))
                .catch(() => undefined)
            }}
            type="button"
          >
            {copiedError ? 'Copied' : 'Copy error'}
          </button>
        ) : operation.status !== 'failed' ? (
          <span className="rounded-full bg-sidebar-accent px-2 py-1 capitalize">{displayStatus.replaceAll('_', ' ')}</span>
        ) : null}
      </div>
      {(displayStatus === 'queued' || displayStatus === 'running') && <p className="text-sidebar-foreground/60">Mint is working. This panel will update automatically.</p>}
      {awaitingReview && (
        <div className="space-y-2">
          {operation.assets?.previewImageUrl && <img alt="Mint model preview" className="max-h-44 w-full rounded-lg object-contain" src={operation.assets.previewImageUrl} />}
          <div className="grid grid-cols-2 gap-2">
            <button className="rounded-md bg-sidebar-primary px-2 py-1.5 text-sidebar-primary-foreground disabled:opacity-50" disabled={props.busy} onClick={props.onApprove} type="button">Approve</button>
            <input className="rounded-md border border-sidebar-border bg-sidebar px-2" maxLength={2000} onChange={(event) => setFeedback(event.target.value)} placeholder="Revision feedback" value={feedback} />
          </div>
          <button className="w-full rounded-md bg-sidebar-accent px-2 py-1.5 disabled:opacity-50" disabled={props.busy || !feedback.trim()} onClick={() => props.onRevise(feedback.trim())} type="button">Revise preview</button>
        </div>
      )}
      {operation.status === 'billing_required' && (
        <div className="space-y-2">
          <p>{operation.billing?.requiredCredits ?? 'More'} Credits required.</p>
          {operation.billing?.actionUrl && <a className="block rounded-md bg-sidebar-primary px-2 py-1.5 text-center text-sidebar-primary-foreground" href={operation.billing.actionUrl} rel="noreferrer" target="_blank">Manage Mint Credits</a>}
          <button className="w-full rounded-md bg-sidebar-accent px-2 py-1.5 disabled:opacity-50" disabled={props.busy} onClick={props.onResume} type="button">Resume after payment</button>
        </div>
      )}
      {operation.status === 'failed' && (
        <div className="space-y-2">
          {showErrorMessage && (
            <p className="leading-5 text-sidebar-foreground/65">{errorMessage}</p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              className="rounded-md border border-sidebar-border px-2 py-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              onClick={props.onDismiss}
              type="button"
            >
              Cancel
            </button>
            <button className="rounded-md bg-sidebar-accent px-2 py-1.5 disabled:opacity-50" disabled={props.busy || operation.resource?.type !== 'model'} onClick={props.onRetry} type="button">Retry model</button>
          </div>
        </div>
      )}
    </section>
  )
}

function operationResultMessage(operation: MintOperation) {
  return `${operationTypeLabel(operation)} ${operation.status.replaceAll('_', ' ')}`
}

function operationTypeLabel(operation: MintOperation) {
  return operation.type
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toUpperCase())
}

function LogoutIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="17" viewBox="0 0 24 24" width="17">
      <path d="M10 17l5-5-5-5M15 12H3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M14 4h4a3 3 0 013 3v10a3 3 0 01-3 3h-4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 11v6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <circle cx="12" cy="7.5" fill="currentColor" r="1" />
    </svg>
  )
}

function LogoutDialog(props: {
  accountName: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center p-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !props.busy) props.onCancel()
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onCancel()
      }}
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.55)', zIndex: 10001 }}
    >
      <section
        aria-labelledby="mint-logout-title"
        aria-modal="true"
        className="w-full max-w-72 space-y-4 rounded-2xl border border-sidebar-border bg-sidebar p-4 shadow-xl"
        role="dialog"
      >
        <div className="space-y-1">
          <h3 className="text-sm font-semibold" id="mint-logout-title">Log out {props.accountName}?</h3>
          <p className="text-xs leading-relaxed text-sidebar-foreground/55">
            You’ll need to connect Mint again to create or place assets.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            autoFocus
            className="rounded-lg bg-sidebar-accent px-3 py-2 text-xs font-medium disabled:opacity-50"
            disabled={props.busy}
            onClick={props.onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
            disabled={props.busy}
            onClick={props.onConfirm}
            type="button"
          >
            {props.busy ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      </section>
    </div>
  )
}

function PanelMessage(props: { title: string; body: string; action?: React.ReactNode; heroSrc?: string; emphasizeBody?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sidebar-foreground">
      {props.heroSrc ? (
        <img
          alt="Mint 3D asset showcase"
          className="w-full rounded-xl border border-sidebar-border object-cover shadow-sm"
          src={props.heroSrc}
          style={{ aspectRatio: '3 / 2', maxWidth: '18rem' }}
        />
      ) : (
        <div className="flex size-12 items-center justify-center rounded-2xl bg-sidebar-accent text-xl font-semibold">M</div>
      )}
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{props.title}</h2>
        <p
          className="leading-relaxed text-sidebar-foreground/60"
          style={{ fontSize: props.emphasizeBody ? '0.875rem' : '0.75rem' }}
        >
          {props.body}
        </p>
      </div>
      {props.action}
    </div>
  )
}

function ErrorNotice(props: { detail: string; onDismiss: () => void }) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-red-500/50 bg-sidebar px-3 py-2 shadow-sm"
      role="alert"
    >
      <p className="min-w-0 flex-1 text-xs font-medium">An error occurred</p>
      <button
        className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        onClick={() => void navigator.clipboard.writeText(props.detail).catch(() => undefined)}
        type="button"
      >
        Copy error
      </button>
      <button
        aria-label="Dismiss error"
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-base leading-none text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        onClick={props.onDismiss}
        type="button"
      >
        ×
      </button>
    </div>
  )
}
