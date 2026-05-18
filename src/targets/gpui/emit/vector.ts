import type { DVector } from '../../../compiler/design-ast.ts'
import { div, image } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { lengthExpr } from './values.ts'

export function emitVector(n: DVector, ctx: GpuiEmitContext, indent: number): string {
  if (!n.asset) return div(indent).toString()
  const chain = image(indent, n.asset)
  // Vectors may omit width/height when the surrounding absolute layout
  // pins both inset edges, since the parent fills the box. Fall back to
  // w_full/h_full so the SVG paints into whatever box the layout produced.
  if (n.width !== undefined) chain.method('w', lengthExpr(n.width, ctx))
  else chain.method('w_full')
  if (n.height !== undefined) chain.method('h', lengthExpr(n.height, ctx))
  else chain.method('h_full')
  chain.method('object_fit', 'ObjectFit::Fill')
  addNodeLayout(chain, n, ctx)
  return chain.toString()
}
