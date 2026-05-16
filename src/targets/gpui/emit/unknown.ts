import type { DUnknown } from '../../../compiler/design-ast.ts'
import { div } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { lengthExpr } from './values.ts'

export function emitUnknown(n: DUnknown, ctx: GpuiEmitContext, indent: number): string {
  const chain = div(indent)
    .method('w', lengthExpr(n.width, ctx))
    .method('h', lengthExpr(n.height, ctx))
  addNodeLayout(chain, n, ctx)
  return chain.toString()
}
