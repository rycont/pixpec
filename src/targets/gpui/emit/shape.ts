import type { DShape } from '../../../compiler/design-ast.ts'
import { ShapeKind } from '../../../compiler/design-ast.ts'
import { div } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { num } from './rust.ts'
import { colorExpr, lengthExpr, lengthNumber } from './values.ts'

export function emitShape(n: DShape, ctx: GpuiEmitContext, indent: number): string {
  // A `Line` shape has zero thickness on one axis; its stroke width is what
  // the user actually sees. Render it as a filled rect of stroke-thickness so
  // GPUI's box model can draw it.
  const isLine = n.shape === ShapeKind.Line
  const strokeWidth = n.stroke ? lengthNumber(n.stroke.width, ctx) : 0
  const w = isLine && lengthNumber(n.width, ctx) === 0 && strokeWidth > 0 ? strokeWidth : lengthNumber(n.width, ctx)
  const h = isLine && lengthNumber(n.height, ctx) === 0 && strokeWidth > 0 ? strokeWidth : lengthNumber(n.height, ctx)
  const chain = div(indent)
    .method('w', lengthExpr({ kind: 'literal', value: { value: w, unit: 'px' } }, ctx))
    .method('h', lengthExpr({ kind: 'literal', value: { value: h, unit: 'px' } }, ctx))
  addNodeLayout(chain, n, ctx)

  if (isLine && n.stroke) {
    chain.method('bg', colorExpr(n.stroke.paint, ctx))
  } else {
    if (n.fill) chain.method('bg', colorExpr(n.fill, ctx))
    if (n.stroke) {
      chain.method('border', lengthExpr(n.stroke.width, ctx))
      chain.method('border_color', colorExpr(n.stroke.paint, ctx))
    }
  }
  if (n.shape === ShapeKind.Ellipse) chain.method('rounded_full')
  if (n.opacity !== undefined) chain.method('opacity', num(n.opacity))

  return chain.toString()
}
