import type { DInstance } from '../../../compiler/design-ast.ts'
import { div } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { isAxisLength, lengthExpr } from './values.ts'

export function emitInstance(n: DInstance, ctx: GpuiEmitContext, indent: number): string {
  const chain = div(indent)
  if (isAxisLength(n.width)) chain.method('w', lengthExpr(n.width, ctx))
  if (isAxisLength(n.height)) chain.method('h', lengthExpr(n.height, ctx))
  addNodeLayout(chain, n, ctx)
  return chain.toString()
}
