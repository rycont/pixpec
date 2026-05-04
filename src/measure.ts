// DEPRECATED 2026-05-02 — replaced by Rust npm bin `pixpec-measure`
// (measure-rs/). Source kept commented out for reference only; do not
// import. Will be deleted once consumers stop pulling on the old types.

// /**
//  * HSB Euclidean dE — TS port of experiments/lib/measure.py:measure_hsb_diff.
//  *
//  * Pipeline:
//  *   1. Load PNGs, flatten alpha onto white → RGB uint8.
//  *   2. Pad impl by (pad_x, pad_y) with white.
//  *   3. Coarse align via grayscale TM_SQDIFF (cv.matchTemplate).
//  *   4. Refine ±refine px (integer grid) minimizing combined HSB diff.
//  *   5. Sub-pixel refine via cv.warpAffine + INTER_LINEAR
//  *      (coarse 0.25 step over ±subpix_range, fine subpix_step over ±0.25).
//  *   6. At final shift, return per-axis HSV-Euclidean sums.
//  *
//  * Hue is circular (cv HSV: H ∈ [0,179]) and weighted by min(saturation) so that
//  * ΔH is meaningful only between two saturated pixels (grayscale text → ΔH=0).
//  */
// import cv from '@techstark/opencv-js'
// import sharp from 'sharp'
//
// let ready: Promise<void> | null = null
// function ensureReady(): Promise<void> {
//   if (ready) return ready
//   ready = new Promise<void>((resolve) => {
//     // @techstark/opencv-js calls onRuntimeInitialized once the WASM module
//     // finishes loading. If it's already initialized we still resolve.
//     // eslint-disable-next-line @typescript-eslint/no-explicit-any
//     const c = cv as any
//     if (c.Mat && typeof c.Mat === 'function') {
//       // Probe: a Mat allocation should succeed when fully ready.
//       try {
//         const m = new c.Mat()
//         m.delete()
//         resolve()
//         return
//       } catch {
//         /* fall through to event */
//       }
//     }
//     c.onRuntimeInitialized = () => resolve()
//   })
//   return ready
// }
//
// export interface MeasureOptions {
//   padX?: number
//   padY?: number
//   refine?: number
//   subpix?: boolean
//   subpixStep?: number
//   subpixRange?: number
// }
//
// export interface MeasureResult {
//   dE_hsb: number
//   dH_weighted: number
//   dS: number
//   dV: number
//   dx: number
//   dy: number
// }
//
// /** Load PNG, flatten alpha onto white, return RGB uint8 buffer + dims. */
// async function loadRgb(path: string) {
//   const { data, info } = await sharp(path)
//     .flatten({ background: { r: 255, g: 255, b: 255 } })
//     .removeAlpha()
//     .raw()
//     .toBuffer({ resolveWithObject: true })
//   return { data, width: info.width, height: info.height }
// }
//
// /** Construct a cv.Mat (CV_8UC3) from a tightly-packed RGB buffer. */
// function matFromRgb(rgb: Buffer, w: number, h: number): cv.Mat {
//   const m = new cv.Mat(h, w, cv.CV_8UC3)
//   m.data.set(rgb)
//   return m
// }
//
// /**
//  * Per-pixel HSV Euclidean distance between a base HSV plane (W×H, contiguous)
//  * and a sub-region of an impl HSV plane (fullW×fullH, contiguous) at offset
//  * (sl, st). Avoids opencv.js Mat ROI semantics entirely — works on raw bytes.
//  */
// function hsbDistAt(
//   base: Uint8Array,
//   W: number,
//   H: number,
//   impl: Uint8Array,
//   fullW: number,
//   sl: number,
//   st: number,
// ): { dh: number; ds: number; dv: number; combined: number } {
//   let dh = 0
//   let ds = 0
//   let dv = 0
//   let comb = 0
//   for (let y = 0; y < H; y++) {
//     let bo = y * W * 3
//     let io = ((st + y) * fullW + sl) * 3
//     for (let x = 0; x < W; x++) {
//       let dhv = Math.abs(base[bo] - impl[io])
//       if (dhv > 90) dhv = 180 - dhv
//       const dhn = dhv / 180
//       const dsn = Math.abs(base[bo + 1] - impl[io + 1]) / 255
//       const dvn = Math.abs(base[bo + 2] - impl[io + 2]) / 255
//       const satMin = Math.min(base[bo + 1], impl[io + 1]) / 255
//       const dhw = dhn * satMin
//       dh += dhw
//       ds += dsn
//       dv += dvn
//       comb += Math.sqrt(dhw * dhw + dsn * dsn + dvn * dvn)
//       bo += 3
//       io += 3
//     }
//   }
//   return { dh, ds, dv, combined: comb }
// }
//
// /**
//  * Same as hsbDistAt but for two contiguous W×H planes (used after warpAffine
//  * crop where we can't easily express a stride).
//  */
// function hsbDistDirect(
//   a: Uint8Array,
//   b: Uint8Array,
//   W: number,
//   H: number,
// ): { dh: number; ds: number; dv: number; combined: number } {
//   return hsbDistAt(a, W, H, b, W, 0, 0)
// }
//
// /** Convert an RGB Buffer (w*h*3) to HSV via opencv.js, returning the new buffer. */
// function rgbToHsvBuffer(rgb: Buffer, w: number, h: number): Uint8Array {
//   const src = matFromRgb(rgb, w, h)
//   const dst = new cv.Mat()
//   cv.cvtColor(src, dst, cv.COLOR_RGB2HSV)
//   // dst.data is a SubArray view into WASM heap; copy to a Node Buffer-backed
//   // Uint8Array so it remains valid after dst.delete().
//   const out = new Uint8Array(dst.data)
//   src.delete()
//   dst.delete()
//   return out
// }
//
// /** Convert RGB→GRAY, return W*H buffer. */
// function rgbToGrayBuffer(rgb: Buffer, w: number, h: number): Uint8Array {
//   const src = matFromRgb(rgb, w, h)
//   const dst = new cv.Mat()
//   cv.cvtColor(src, dst, cv.COLOR_RGB2GRAY)
//   const out = new Uint8Array(dst.data)
//   src.delete()
//   dst.delete()
//   return out
// }
//
// export async function measureHsbDiff(
//   baseRgbPath: string,
//   implRgbPath: string,
//   opts: MeasureOptions = {},
// ): Promise<MeasureResult> {
//   await ensureReady()
//
//   const padX = opts.padX ?? 40
//   const padY = opts.padY ?? 80
//   const refine = opts.refine ?? 5
//   const subpix = opts.subpix ?? true
//   const subpixStep = opts.subpixStep ?? 0.1
//   const subpixRange = opts.subpixRange ?? 2.0
//
//   const base = await loadRgb(baseRgbPath)
//   const impl = await loadRgb(implRgbPath)
//   const W = Math.max(base.width, impl.width)
//   const H = Math.max(base.height, impl.height)
//   const fullW = W + 2 * padX
//   const fullH = H + 2 * padY
//
//   // Build padded canvases on white (contiguous, plain Node Buffers).
//   const baseCanvas = Buffer.alloc(W * H * 3, 255)
//   for (let y = 0; y < base.height; y++) {
//     base.data.copy(
//       baseCanvas,
//       y * W * 3,
//       y * base.width * 3,
//       y * base.width * 3 + base.width * 3,
//     )
//   }
//   const implCanvas = Buffer.alloc(fullW * fullH * 3, 255)
//   for (let y = 0; y < impl.height; y++) {
//     const dstOff = ((y + padY) * fullW + padX) * 3
//     impl.data.copy(
//       implCanvas,
//       dstOff,
//       y * impl.width * 3,
//       y * impl.width * 3 + impl.width * 3,
//     )
//   }
//
//   // HSV buffers (own memory, safe across opencv allocs).
//   const baseHsv = rgbToHsvBuffer(baseCanvas, W, H)
//   const implHsv = rgbToHsvBuffer(implCanvas, fullW, fullH)
//
//   // Coarse: matchTemplate TM_SQDIFF on grayscale.
//   const baseGrayBuf = rgbToGrayBuffer(baseCanvas, W, H)
//   const implGrayBuf = rgbToGrayBuffer(implCanvas, fullW, fullH)
//   const baseGray = new cv.Mat(H, W, cv.CV_8UC1)
//   baseGray.data.set(baseGrayBuf)
//   const implGray = new cv.Mat(fullH, fullW, cv.CV_8UC1)
//   implGray.data.set(implGrayBuf)
//   const result = new cv.Mat()
//   cv.matchTemplate(implGray, baseGray, result, cv.TM_SQDIFF)
//   // Declared TS signature mirrors C++ outptr style; the JS impl takes (src) and returns the struct.
//   const mm = (cv.minMaxLoc as unknown as (m: cv.Mat) => { minLoc: { x: number; y: number }; maxLoc: { x: number; y: number }; minVal: number; maxVal: number })(result)
//   let srcLeft = mm.minLoc.x
//   let srcTop = mm.minLoc.y
//   baseGray.delete()
//   implGray.delete()
//   result.delete()
//
//   // Integer refine (±refine).
//   if (refine > 0) {
//     let bestC: number | null = null
//     let bestSL = srcLeft
//     let bestST = srcTop
//     for (let dy = -refine; dy <= refine; dy++) {
//       for (let dx = -refine; dx <= refine; dx++) {
//         const sl = srcLeft + dx
//         const st = srcTop + dy
//         if (sl < 0 || st < 0 || sl + W > fullW || st + H > fullH) continue
//         const { combined } = hsbDistAt(baseHsv, W, H, implHsv, fullW, sl, st)
//         if (bestC === null || combined < bestC) {
//           bestC = combined
//           bestSL = sl
//           bestST = st
//         }
//       }
//     }
//     if (process.env.PIXPEC_DEBUG) {
//       console.error(
//         `[measure] coarse=(${srcLeft},${srcTop})  refined=(${bestSL},${bestST})  bestC=${bestC?.toFixed(2)}`,
//       )
//     }
//     srcLeft = bestSL
//     srcTop = bestST
//   }
//
//   // Sub-pixel refine via warpAffine on a local RGB crop.
//   let subDx = 0
//   let subDy = 0
//   let dh = 0
//   let ds = 0
//   let dv = 0
//   let combined = 0
//
//   if (subpix) {
//     const margin = Math.ceil(subpixRange) + 2
//     const sl = Math.max(0, srcLeft - margin)
//     const st = Math.max(0, srcTop - margin)
//     const slEnd = Math.min(fullW, srcLeft + W + margin)
//     const stEnd = Math.min(fullH, srcTop + H + margin)
//     const lw = slEnd - sl
//     const lh = stEnd - st
//     const offX = srcLeft - sl
//     const offY = srcTop - st
//
//     // Build a contiguous lw×lh RGB buffer of the local impl region.
//     const localRgb = Buffer.alloc(lw * lh * 3, 255)
//     for (let y = 0; y < lh; y++) {
//       const src = ((st + y) * fullW + sl) * 3
//       implCanvas.copy(localRgb, y * lw * 3, src, src + lw * 3)
//     }
//     const localMat = matFromRgb(localRgb, lw, lh)
//
//     const evalShift = (sy: number, sx: number) => {
//       const M = cv.matFromArray(2, 3, cv.CV_32F, [1, 0, sx, 0, 1, sy])
//       const shifted = new cv.Mat()
//       cv.warpAffine(
//         localMat,
//         shifted,
//         M,
//         new cv.Size(lw, lh),
//         cv.INTER_LINEAR,
//         cv.BORDER_CONSTANT,
//         new cv.Scalar(255, 255, 255),
//       )
//       // Copy (offX, offY, W, H) region out into a contiguous W×H RGB buffer.
//       const winRgb = Buffer.alloc(W * H * 3)
//       const shiftedData = shifted.data as Uint8Array
//       for (let y = 0; y < H; y++) {
//         const src = ((offY + y) * lw + offX) * 3
//         for (let i = 0; i < W * 3; i++) winRgb[y * W * 3 + i] = shiftedData[src + i]
//       }
//       const winHsv = rgbToHsvBuffer(winRgb, W, H)
//       const r = hsbDistDirect(baseHsv, winHsv, W, H)
//       M.delete()
//       shifted.delete()
//       return r
//     }
//
//     const coarseStep = 0.25
//     let bestC: number | null = null
//     let bx = 0
//     let by = 0
//     for (let sy = -subpixRange; sy <= subpixRange + 1e-9; sy += coarseStep) {
//       for (let sx = -subpixRange; sx <= subpixRange + 1e-9; sx += coarseStep) {
//         const r = evalShift(sy, sx)
//         if (bestC === null || r.combined < bestC) {
//           bestC = r.combined
//           bx = sx
//           by = sy
//         }
//       }
//     }
//     subDx = bx
//     subDy = by
//     for (let sy = -coarseStep; sy <= coarseStep + 1e-9; sy += subpixStep) {
//       for (let sx = -coarseStep; sx <= coarseStep + 1e-9; sx += subpixStep) {
//         const r = evalShift(by + sy, bx + sx)
//         if (bestC === null || r.combined < bestC) {
//           bestC = r.combined
//           subDx = bx + sx
//           subDy = by + sy
//         }
//       }
//     }
//     const r = evalShift(subDy, subDx)
//     dh = r.dh
//     ds = r.ds
//     dv = r.dv
//     combined = r.combined
//     localMat.delete()
//   } else {
//     const r = hsbDistAt(baseHsv, W, H, implHsv, fullW, srcLeft, srcTop)
//     dh = r.dh
//     ds = r.ds
//     dv = r.dv
//     combined = r.combined
//   }
//
//   return {
//     dE_hsb: combined,
//     dH_weighted: dh,
//     dS: ds,
//     dV: dv,
//     dx: padX - srcLeft - subDx,
//     dy: padY - srcTop - subDy,
//   }
// }
