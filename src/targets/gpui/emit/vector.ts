import type { DVector } from '../../../compiler/design-ast.ts'
import { dataUrlAsset, putTextAsset } from './assets.ts'
import { div, image } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { lengthExpr } from './values.ts'

export function emitVector(n: DVector, ctx: GpuiEmitContext, indent: number): string {
  const sourceId = n.sourceId ?? 'vector'
  const path = n.svg.startsWith('data:')
    ? dataUrlAsset(ctx, sourceId, n.svg)
    : putTextAsset(ctx, sourceId, 'svg', n.svg)
  if (!path) return div(indent).toString()

  const chain = image(indent, path)
    .method('w', lengthExpr(n.width, ctx))
    .method('h', lengthExpr(n.height, ctx))
    .method('object_fit', 'ObjectFit::Fill')
  addNodeLayout(chain, n, ctx)
  return chain.toString()
}
