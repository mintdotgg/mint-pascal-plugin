import type { AssetInput } from '@pascal-app/core'
import { mintModelToAsset } from './mapping'
import type { GlbBounds, MintPluginModel } from './types'

export type PascalPlacementStores = {
  viewer: {
    setSelection: (selection: { selectedIds: string[]; zoneId: null }) => void
  }
  editor: {
    setSelectedItem: (asset: AssetInput) => void
    setTool: (tool: 'item') => void
    setMode: (mode: 'build') => void
  }
}

export function armMintAssetForPlacement(
  model: MintPluginModel,
  bounds: GlbBounds,
  stores: PascalPlacementStores,
) {
  const asset = mintModelToAsset(model, bounds)
  stores.viewer.setSelection({ selectedIds: [], zoneId: null })
  stores.editor.setSelectedItem(asset)
  stores.editor.setTool('item')
  stores.editor.setMode('build')
  return asset
}
