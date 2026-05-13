export interface GpuiEmitContext {
  tokenValueMap: Record<string, number>
  tokenColorMap: Record<string, string>
  renderScale: number
  fonts?: GpuiFontManifest
  assets: Map<string, GpuiAsset>
}

export interface GpuiAsset {
  relativePath: string
  content: string | Uint8Array
}

export interface GpuiFontManifest {
  fonts?: GpuiFontCalibration[]
}

export interface GpuiFontCalibration {
  family: string
  xShift?: Record<string, number>
  yShift?: Record<string, number>
}
