import type { DVector } from '../../../compiler/design-ast.ts'
import { dataUrlAsset, putTextAsset } from './assets.ts'
import { div, image } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { lengthExpr } from './values.ts'

export function emitVector(n: DVector, ctx: GpuiEmitContext, indent: number): string {
  const sourceId = n.sourceId ?? 'vector'
  // DVector carries `asset` (a sidecar filename produced by compile's
  // persistSvgString). Legacy code expected `svg` (inline string) which no
  // longer exists; the SVG-fold path (compile.ts ~1554) already persists the
  // SVG bytes to disk and only references them by filename here.
  const asset = (n as DVector & { svg?: string }).svg
  const path = asset
    ? asset.startsWith('data:')
      ? dataUrlAsset(ctx, sourceId, asset)
      : putTextAsset(ctx, sourceId, 'svg', asset)
    : n.asset
  if (!path) return div(indent).toString()

  const chain = image(indent, path)
    .method('w', lengthExpr(n.width, ctx))
    .method('h', lengthExpr(n.height, ctx))
    .method('object_fit', 'ObjectFit::Fill')
  addNodeLayout(chain, n, ctx)
  return chain.toString()
}
