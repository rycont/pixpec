export { defineComponent } from './types.ts'
export type {
  Component,
  Case,
  CaseResult,
  NoiseFn,
  Metric,
} from './types.ts'
// JS measure path (cv.matchTemplate + sub-pixel sweep) deprecated 2026-05-02 in
// favour of `measure-rs/` Rust binary. The TS files measure.ts / measure-pool.ts
// / measure-worker.ts are commented-out in their entirety. Use the `pixpec
// measure` CLI (which now spawns the Rust binary).
// export { measureHsbDiff } from './measure.ts'
// export type { MeasureOptions, MeasureResult } from './measure.ts'
export { Renderer } from './render.ts'
export type { RenderUrlOptions } from './render.ts'
export { exportFigmaNode, exportFigmaNodes } from './figma.ts'
export type { FigmaExportOptions } from './figma.ts'
// export { measureBatch } from './measure-pool.ts'
// export type { MeasureJob } from './measure-pool.ts'
// runComponents (verify runner) deprecated — use split scripts:
// scripts/dump-figma.ts + dump-chromium.ts + measure.ts
export { fetchComponentMeta } from './cfigma-meta.ts'
export type {
  FigmaComponentMeta,
  FigmaPropertyDefinition,
  FigmaPropType,
  FigmaPropValue,
  FigmaVariantMeta,
  FigmaInstanceSwapValue,
} from './cfigma-meta.ts'
export { init, loadConfig } from './init.ts'
export type { PixpecConfig, InitResult } from './init.ts'
export { switchToPageContaining } from './cfigma-meta.ts'
