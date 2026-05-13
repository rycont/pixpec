import type { DShape } from '../../../compiler/design-ast.ts'
import { ShapeKind } from '../../../compiler/design-ast.ts'
import { div } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { num } from './rust.ts'
import { colorExpr, sizeExpr } from './values.ts'

export function emitShape(n: DShape, ctx: GpuiEmitContext, indent: number): string {
  const chain = div(indent)
    .method('w', sizeExpr(n.width, ctx))
    .method('h', sizeExpr(n.height, ctx))
  addNodeLayout(chain, n, ctx)

  if (n.fill) chain.method('bg', colorExpr(n.fill, ctx))
  if (n.shape === ShapeKind.Ellipse) chain.method('rounded_full')
  if (n.opacity !== undefined) chain.method('opacity', num(n.opacity))

  return chain.toString()
}
