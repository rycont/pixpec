import type { DBox, DFlex, DStack } from '../../../compiler/design-ast.ts'
import type { GpuiChain } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { num } from './rust.ts'
import { colorExpr, sizeExpr } from './values.ts'

export function addContainerStyles(
  chain: GpuiChain,
  n: DFlex | DStack | DBox,
  ctx: GpuiEmitContext,
): void {
  if (n.background) chain.method('bg', colorExpr(n.background, ctx))
  if (n.border) {
    if ('top' in n.border.width) {
      chain.method('border_t', sizeExpr(n.border.width.top, ctx))
      chain.method('border_r', sizeExpr(n.border.width.right, ctx))
      chain.method('border_b', sizeExpr(n.border.width.bottom, ctx))
      chain.method('border_l', sizeExpr(n.border.width.left, ctx))
    } else {
      chain.method('border', sizeExpr(n.border.width, ctx))
    }
    chain.method('border_color', colorExpr(n.border.paint, ctx))
  }
  if (n.padding) {
    chain.method('pt', sizeExpr(n.padding.top, ctx))
    chain.method('pr', sizeExpr(n.padding.right, ctx))
    chain.method('pb', sizeExpr(n.padding.bottom, ctx))
    chain.method('pl', sizeExpr(n.padding.left, ctx))
  }
  if (n.cornerRadius && !('tl' in n.cornerRadius)) {
    chain.method('rounded', sizeExpr(n.cornerRadius, ctx))
  }
  if (n.opacity !== undefined) chain.method('opacity', num(n.opacity))
  if (n.clip) chain.method('overflow_hidden')
}
