#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const versions = [
  {
    label: 'Pascal 0.9.2',
    expectedVersion: '0.9.2',
    core: '@mint/pascal-core-0-9-2',
    editor: '@mint/pascal-editor-0-9-2',
    viewer: '@mint/pascal-viewer-0-9-2',
  },
  {
    label: 'Pascal 1.0.0-beta.1',
    expectedVersion: '1.0.0-beta.1',
    core: '@pascal-app/core',
    editor: '@pascal-app/editor',
    viewer: '@pascal-app/viewer',
  },
]

function dependencyPath(packageName, ...segments) {
  return path.join(packageRoot, 'node_modules', ...packageName.split('/'), ...segments)
}

async function readDependencyFile(packageName, relativePath) {
  const absolute = dependencyPath(packageName, ...relativePath.split('/'))
  return readFile(absolute, 'utf8').catch((error) => {
    throw new Error(`Unable to read ${packageName}/${relativePath}: ${error.message}`)
  })
}

function requireContract(text, pattern, contract, label) {
  if (!pattern.test(text)) {
    throw new Error(`${label} no longer exposes the expected ${contract} contract.`)
  }
}

async function verifyVersion(version) {
  for (const packageName of [version.core, version.editor, version.viewer]) {
    const manifest = JSON.parse(await readDependencyFile(packageName, 'package.json'))
    if (manifest.version !== version.expectedVersion) {
      throw new Error(
        `${version.label} matrix resolved ${packageName} to ${manifest.version}, expected ${version.expectedVersion}.`,
      )
    }
  }

  const coreRegistry = await readDependencyFile(version.core, 'dist/registry/types.d.ts')
  const coreItem = await readDependencyFile(version.core, 'dist/schema/nodes/item.d.ts')
  requireContract(
    coreRegistry,
    /export type Plugin = \{[\s\S]*?apiVersion: 1;[\s\S]*?nodes\?: AnyNodeDefinition\[\];[\s\S]*?\};/u,
    'Plugin API v1 manifest',
    version.label,
  )
  requireContract(coreItem, /export type AssetInput =/u, 'AssetInput', version.label)

  const editorIndex = await readDependencyFile(version.editor, 'src/index.tsx')
  const editorPanels = await readDependencyFile(version.editor, 'src/lib/plugin-panels.ts')
  const editorStore = await readDependencyFile(version.editor, 'src/store/use-editor.tsx')
  requireContract(editorIndex, /export \{ useViewer \} from '@pascal-app\/viewer'/u, 'useViewer export', version.label)
  requireContract(
    editorIndex,
    /type EditorHostPanel,[\s\S]*?registerEditorHostPanel,/u,
    'host-panel exports',
    version.label,
  )
  requireContract(
    editorPanels,
    /export type EditorHostPanel = \{[\s\S]*?defaultInstalled\?: boolean[\s\S]*?\}/u,
    'EditorHostPanel',
    version.label,
  )
  requireContract(
    editorStore,
    /setSelectedItem: \(item: AssetInput\) => void/u,
    'native item selection',
    version.label,
  )
  requireContract(editorStore, /setTool: \(tool: Tool \| null\) => void/u, 'tool activation', version.label)
  requireContract(editorStore, /setMode: \(mode: Mode\) => void/u, 'build-mode activation', version.label)

  const viewerStore = await readDependencyFile(version.viewer, 'dist/store/use-viewer.d.ts')
  requireContract(
    viewerStore,
    /setSelection: \(updates: Partial<SelectionPath>\) => void;/u,
    'viewer selection clearing',
    version.label,
  )

  console.log(`Verified ${version.label} host contracts.`)
}

for (const version of versions) await verifyVersion(version)

console.log('Pascal compatibility matrix passed.')
