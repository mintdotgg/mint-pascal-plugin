// @pascal-app/editor publishes source, so importing it into this standalone
// package would type-check the entire editor. Mirror only the public surface
// shared by Pascal 0.9.2 and the supported 1.0.0 betas; the gate checks all
// real packages and consumers still resolve their installed peer package.
declare module '@pascal-app/editor' {
  export type EditorHostPanel = {
    id: string
    label: string
    icon: import('@pascal-app/core').IconRef
    component: import('@pascal-app/core').LazyComponent
    kinds?: readonly string[]
    workspaces?: readonly (string & {})[]
    pluginId?: string
    description?: string
    creator?: { name: string; url?: string }
    pluginUrl?: string
    defaultInstalled?: boolean
  }

  type EditorState = {
    setSelectedItem: (item: import('@pascal-app/core').AssetInput) => void
    setTool: (tool: string | null) => void
    setMode: (mode: string) => void
  }

  export const useEditor: { getState: () => EditorState }
}
