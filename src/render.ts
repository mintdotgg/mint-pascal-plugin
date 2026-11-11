import type { Plugin } from '@pascal-app/core'

/**
 * Render-only Mint plugin for read-only viewers: no `@pascal-app/editor`.
 *
 * Mint registers no scene node kinds. Placed Mint models are ordinary Pascal
 * items that render without this plugin; the editor-only parts (the Mint host
 * panel and its placement flow) stay on the root entry. Loading this keeps the
 * plugin id known to viewers that resolve a scene's plugins.
 */
export const mintRenderPlugin = {
  id: 'mint:assets',
  apiVersion: 1,
  nodes: [],
} satisfies Plugin
