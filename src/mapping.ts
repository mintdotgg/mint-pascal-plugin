import type { AssetInput } from '@pascal-app/core'
import type { GlbBounds, MintPluginModel } from './types'
import { modelIsPlaceable, modelThumbnailUrl, placementGlbUrl } from './types'

export const MINT_THUMBNAIL_FALLBACK =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"%3E%3Crect width="64" height="64" rx="12" fill="%23171717"/%3E%3Cpath fill="white" d="M15 18h8l9 13 9-13h8v28h-8V30l-9 13-9-13v16h-8z"/%3E%3C/svg%3E'

export function mintModelToAsset(model: MintPluginModel, bounds: GlbBounds): AssetInput {
  const sourceUrl = placementGlbUrl(model)
  if (!sourceUrl || !modelIsPlaceable(model)) {
    throw new Error('This model must be succeeded with a GLB before it can be placed.')
  }

  return {
    id: `mint:model:${model.id}`,
    category: 'furniture',
    name: model.name ?? 'Untitled Mint model',
    thumbnail: modelThumbnailUrl(model) ?? MINT_THUMBNAIL_FALLBACK,
    source: 'mine',
    src: sourceUrl,
    dimensions: bounds.size,
    offset: [-bounds.center[0], -bounds.min[1], -bounds.center[2]],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    tags: ['mint'],
  }
}
