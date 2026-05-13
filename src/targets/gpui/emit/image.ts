import type { DImage } from '../../../compiler/design-ast.ts'
import { dataUrlAsset, putBinaryAssetWithSuffix } from './assets.ts'
import { div, image } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { sizeExpr, sizeValue } from './values.ts'

export async function emitImage(n: DImage, ctx: GpuiEmitContext, indent: number): Promise<string> {
  if (!n.dataUrl) {
    const chain = div(indent)
      .method('w', sizeExpr(n.width, ctx))
      .method('h', sizeExpr(n.height, ctx))
    addNodeLayout(chain, n, ctx)
    return chain.toString()
  }

  const path = await imageAsset(ctx, n)
  if (!path) {
    const chain = div(indent)
      .method('w', sizeExpr(n.width, ctx))
      .method('h', sizeExpr(n.height, ctx))
    addNodeLayout(chain, n, ctx)
    return chain.toString()
  }

  const chain = image(indent, path)
    .method('w', sizeExpr(n.width, ctx))
    .method('h', sizeExpr(n.height, ctx))
    .method('object_fit', 'ObjectFit::Fill')
  addNodeLayout(chain, n, ctx)
  return chain.toString()
}

async function imageAsset(ctx: GpuiEmitContext, n: DImage): Promise<string | undefined> {
  const crop = n.imageScaleMode === 'CROP' ? cropRect(n.imageTransform) : undefined
  if (!crop) return dataUrlAsset(ctx, n.sourceId, n.dataUrl!)

  const match = /^data:([^;,]+);base64,(.*)$/s.exec(n.dataUrl!)
  if (!match) return dataUrlAsset(ctx, n.sourceId, n.dataUrl!)
  const mime = match[1]?.toLowerCase()
  if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') {
    return dataUrlAsset(ctx, n.sourceId, n.dataUrl!)
  }

  try {
    const sharp = (await import('sharp')).default
    const input = Buffer.from(match[2] ?? '', 'base64')
    const meta = await sharp(input).metadata()
    if (!meta.width || !meta.height) return dataUrlAsset(ctx, n.sourceId, n.dataUrl!)
    const left = clamp(Math.round(crop.x * meta.width), 0, meta.width - 1)
    const top = clamp(Math.round(crop.y * meta.height), 0, meta.height - 1)
    const right = clamp(Math.round((crop.x + crop.width) * meta.width), left + 1, meta.width)
    const bottom = clamp(Math.round((crop.y + crop.height) * meta.height), top + 1, meta.height)
    const targetWidth = Math.round(sizeValue(n.width, ctx) * ctx.renderScale)
    const targetHeight = Math.round(sizeValue(n.height, ctx) * ctx.renderScale)
    let pipeline = sharp(input)
      .extract({ left, top, width: right - left, height: bottom - top })
    if (targetWidth > 0 && targetHeight > 0) {
      pipeline = pipeline.resize(targetWidth, targetHeight, { fit: 'fill' })
    }
    const cropped = await pipeline
      .png()
      .toBuffer()
    return putBinaryAssetWithSuffix(ctx, n.sourceId, 'crop', 'png', cropped)
  } catch {
    return dataUrlAsset(ctx, n.sourceId, n.dataUrl!)
  }
}

function cropRect(transform: DImage['imageTransform']):
  | { x: number; y: number; width: number; height: number }
  | undefined {
  if (!transform) return undefined
  const [[a, b, c], [d, e, f]] = transform
  if (Math.abs(b) > 1e-6 || Math.abs(d) > 1e-6 || a <= 0 || e <= 0) return undefined
  const x0 = Math.max(0, c)
  const y0 = Math.max(0, f)
  const x1 = Math.min(1, c + a + Math.min(0, c))
  const y1 = Math.min(1, f + e + Math.min(0, f))
  if (x1 <= x0 || y1 <= y0) return undefined
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
