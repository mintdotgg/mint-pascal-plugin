// Narrow public surface shared by both supported Pascal versions; see
// pascal-editor.d.ts and the compatibility gate.
declare module '@pascal-app/viewer' {
  type ViewerState = {
    setSelection: (selection: { selectedIds: string[]; zoneId: string | null }) => void
  }

  export const useViewer: { getState: () => ViewerState }
}
