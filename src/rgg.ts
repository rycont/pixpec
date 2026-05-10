/**
 * Per-axis HSV diff maps. Three files per case: `rgg-h.png`, `rgg-s.png`,
 * `rgg-v.png`.
 *
 *   gray (230) — perfect match on that axis
 *   red shade — figma value lower than impl (negative delta), intensity ∝ |delta|
 *   green shade — figma value higher than impl (positive delta), intensity ∝ |delta|
 *
 * Per-axis scales:
 *   H — cv2-style 0..179 (180-wrap); diff folded to [-90, 90] (shortest arc)
 *   S — 0..255
 *   V — 0..255
 *
 * The impl image is sub-pixel shifted by `(dx, dy)` (the offsets returned
 * by `measure_hsb_diff`) before differencing — so the maps reflect the
 * residual that the dE metric actually summed, not raw positional diff.
 */
import sharp from 'sharp'

async function loadRgb(path: string) {
  const { data, info } = await sharp(path)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, w: info.width, h: info.height }
}

/** RGB (0..255) → cv2-style HSV (H 0..179, S 0..255, V 0..255). */
function rgb2hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const v = max
  const d = max - min
  const s = max === 0 ? 0 : (d * 255) / max
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 30 // *60 then /2
  }
  return [h, s, v]
}

const BASE = 230 // light gray
const POS = [40, 200, 60] as const // green
const NEG = [220, 50, 50] as const // red

function paint(out: Buffer, o: number, delta: number, scale: number): void {
  const intensity = Math.min(Math.abs(delta) / scale, 1)
  const target = delta >= 0 ? POS : NEG
  out[o] = Math.round(BASE + (target[0] - BASE) * intensity)
  out[o + 1] = Math.round(BASE + (target[1] - BASE) * intensity)
  out[o + 2] = Math.round(BASE + (target[2] - BASE) * intensity)
}

export interface WriteRggOptions {
  /** Hue scale: dH folded to [-90, 90]. */
  hScale?: number
  sScale?: number
  vScale?: number
  /**
   * Sub-pixel shift to apply to the impl image before diffing — pass the
   * `(dx, dy)` returned by measure_hsb_diff so the RGG matches the residual
   * the dE metric actually counted. Without this, RGG shows raw positional
   * diff which can mask the AA-level signal.
   */
  shiftX?: number
  shiftY?: number
}

/** Bilinear sample of the impl image at fractional (sx, sy). Edge handling
 * clamps the +1 neighbor to the last in-bounds index instead of bailing to
 * white — without this, an integer sample at the last row/column (very
 * common when shift is 0) lost the actual pixel and rgg painted a spurious
 * full-width stripe along the bottom/right edge. Fully out-of-bounds
 * samples (sx < 0 etc.) still return white since there's no real pixel. */
function sampleRgb(buf: Buffer, w: number, h: number, sx: number, sy: number): [number, number, number] {
  if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) return [255, 255, 255]
  const x0 = Math.floor(sx)
  const y0 = Math.floor(sy)
  const x1 = Math.min(x0 + 1, w - 1)
  const y1 = Math.min(y0 + 1, h - 1)
  const fx = sx - x0
  const fy = sy - y0
  const idx = (yy: number, xx: number) => (yy * w + xx) * 3
  const a = idx(y0, x0)
  const b = idx(y0, x1)
  const c = idx(y1, x0)
  const d = idx(y1, x1)
  const blend = (i: number) =>
    buf[a + i] * (1 - fx) * (1 - fy) +
    buf[b + i] * fx * (1 - fy) +
    buf[c + i] * (1 - fx) * fy +
    buf[d + i] * fx * fy
  return [blend(0), blend(1), blend(2)]
}

export async function writeRggMaps(
  figmaPath: string,
  implPath: string,
  outDir: string,
  opts: WriteRggOptions = {},
): Promise<{ h: string; s: string; v: string }> {
  const f = await loadRgb(figmaPath)
  const i = await loadRgb(implPath)
  const W = Math.max(f.w, i.w)
  const H = Math.max(f.h, i.h)
  const hScale = opts.hScale ?? 90
  const sScale = opts.sScale ?? 255
  const vScale = opts.vScale ?? 255
  const shiftX = opts.shiftX ?? 0
  const shiftY = opts.shiftY ?? 0

  const hOut = Buffer.alloc(W * H * 3, BASE)
  const sOut = Buffer.alloc(W * H * 3, BASE)
  const vOut = Buffer.alloc(W * H * 3, BASE)

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= f.w || y >= f.h) continue
      const fIdx = (y * f.w + x) * 3
      // Sample impl at the shifted coordinates so RGG matches what dE counted.
      const sx = x + shiftX
      const sy = y + shiftY
      const [iR, iG, iB] = sampleRgb(i.data, i.w, i.h, sx, sy)
      const [fh, fs, fv] = rgb2hsv(f.data[fIdx], f.data[fIdx + 1], f.data[fIdx + 2])
      const [ih, is, iv] = rgb2hsv(iR, iG, iB)
      // Hue: shortest signed arc on 0..179 wrap.
      let dh = fh - ih
      if (dh > 90) dh -= 180
      else if (dh < -90) dh += 180
      const ds = fs - is
      const dv = fv - iv
      const o = (y * W + x) * 3
      paint(hOut, o, dh, hScale)
      paint(sOut, o, ds, sScale)
      paint(vOut, o, dv, vScale)
    }
  }

  const hPath = `${outDir}/rgg-h.png`
  const sPath = `${outDir}/rgg-s.png`
  const vPath = `${outDir}/rgg-v.png`
  await Promise.all([
    sharp(hOut, { raw: { width: W, height: H, channels: 3 } }).png().toFile(hPath),
    sharp(sOut, { raw: { width: W, height: H, channels: 3 } }).png().toFile(sPath),
    sharp(vOut, { raw: { width: W, height: H, channels: 3 } }).png().toFile(vPath),
  ])
  return { h: hPath, s: sPath, v: vPath }
}
