import { createHash } from 'node:crypto'

import type { GpuiEmitContext } from './context.ts'

export function putTextAsset(
  ctx: GpuiEmitContext,
  sourceId: string,
  extension: string,
  content: string,
): string {
  return putAsset(ctx, sourceId, extension, content)
}

export function putBinaryAsset(
  ctx: GpuiEmitContext,
  sourceId: string,
  extension: string,
  content: Uint8Array,
): string {
  return putAsset(ctx, sourceId, extension, content)
}

export function putBinaryAssetWithSuffix(
  ctx: GpuiEmitContext,
  sourceId: string,
  suffix: string,
  extension: string,
  content: Uint8Array,
): string {
  return putAsset(ctx, `${sourceId}_${suffix}`, extension, content)
}

export function dataUrlAsset(
  ctx: GpuiEmitContext,
  sourceId: string,
  dataUrl: string,
): string | undefined {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return undefined
  const mime = match[1]?.toLowerCase()
  const isBase64 = !!match[2]
  const payload = match[3] ?? ''
  const extension = extensionForMime(mime)
  if (!extension) return undefined

  if (isBase64) {
    return putBinaryAsset(ctx, sourceId, extension, Buffer.from(payload, 'base64'))
  }
  return putTextAsset(ctx, sourceId, extension, decodeURIComponent(payload))
}

function putAsset(
  ctx: GpuiEmitContext,
  sourceId: string,
  extension: string,
  content: string | Uint8Array,
): string {
  const hash = createHash('sha1')
    .update(typeof content === 'string' ? content : content)
    .digest('hex')
    .slice(0, 10)
  const stem = sourceId.replace(/[^A-Za-z0-9]/g, '_') || 'asset'
  const relativePath = `pixpec-assets/${stem}_${hash}.${extension}`
  ctx.assets.set(relativePath, { relativePath, content })
  return relativePath
}

function extensionForMime(mime: string | undefined): string | undefined {
  switch (mime) {
    case 'image/svg+xml':
      return 'svg'
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return undefined
  }
}
