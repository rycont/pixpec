import type { DInstance } from '../../../compiler/design-ast.ts'
import { div } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { sizeExpr } from './values.ts'

export function emitInstance(n: DInstance, ctx: GpuiEmitContext, indent: number): string {
  const chain = div(indent)
  if (n.width) chain.method('w', sizeExpr(n.width, ctx))
  if (n.height) chain.method('h', sizeExpr(n.height, ctx))
  addNodeLayout(chain, n, ctx)
  return chain.toString()
}
