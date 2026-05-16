import type { DInstance } from '../../../compiler/design-ast.ts'
import { div } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'

export function emitInstance(n: DInstance, ctx: GpuiEmitContext, indent: number): string {
  const chain = div(indent)
  addNodeLayout(chain, n, ctx)
  return chain.toString()
}
