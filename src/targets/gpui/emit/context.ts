export interface GpuiEmitContext {
  tokenValueMap: Record<string, number>
  tokenColorMap: Record<string, string>
  renderScale: number
  fonts?: GpuiFontManifest
  assets: Map<string, GpuiAsset>
  /** Default values of props promoted to the surrounding DataScope. GPUI
   *  emits variant-baked code (no runtime prop reads), so any prop expression
   *  encountered during lowering is resolved to the variant's concrete
   *  default. Populated when entering a DataScope. */
  propDefaults?: Record<string, unknown>
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
