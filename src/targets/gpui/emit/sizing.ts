import type { DBox, DFlex, DStack } from '../../../compiler/design-ast.ts'
import { Sizing } from '../../../compiler/design-ast.ts'
import type { GpuiChain } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { sizeExpr } from './values.ts'

export function addSizing(
  chain: GpuiChain,
  n: DFlex | DStack | DBox,
  ctx: GpuiEmitContext,
): void {
  if (n.sizing?.horizontal === Sizing.Fill) chain.method('w_full')
  else if (n.sizing?.horizontal !== Sizing.Hug && n.width) chain.method('w', sizeExpr(n.width, ctx))

  if (n.sizing?.vertical === Sizing.Fill) chain.method('h_full')
  else if (n.sizing?.vertical !== Sizing.Hug && n.height) chain.method('h', sizeExpr(n.height, ctx))
}
