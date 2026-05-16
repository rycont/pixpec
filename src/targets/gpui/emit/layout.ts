import type { DNode } from '../../../compiler/design-ast.ts'
import { Anchor } from '../../../compiler/design-ast.ts'
import type { GpuiChain } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { lengthNumber, scaledPx, scaledPxWithOffset } from './values.ts'

export function addNodeLayout(
  chain: GpuiChain,
  n: DNode,
  ctx: GpuiEmitContext,
  offset: { x?: number; y?: number } = {},
): void {
  if (!n.absolute) return

  const inset = n.absolute.inset ?? {}
  const anchor = n.absolute.anchor ?? {}
  chain.method('absolute')

  if (anchor.horizontal === Anchor.End) {
    if (inset.right !== undefined) chain.method('right', scaledPxWithOffset(lengthNumber(inset.right, ctx), ctx, offset.x))
  } else if (anchor.horizontal === Anchor.Stretch) {
    if (inset.left !== undefined) chain.method('left', scaledPxWithOffset(lengthNumber(inset.left, ctx), ctx, offset.x))
    if (inset.right !== undefined) chain.method('right', scaledPx(lengthNumber(inset.right, ctx), ctx))
  } else {
    if (inset.left !== undefined) chain.method('left', scaledPxWithOffset(lengthNumber(inset.left, ctx), ctx, offset.x))
  }

  if (anchor.vertical === Anchor.End) {
    if (inset.bottom !== undefined) chain.method('bottom', scaledPxWithOffset(lengthNumber(inset.bottom, ctx), ctx, offset.y))
  } else if (anchor.vertical === Anchor.Stretch) {
    if (inset.top !== undefined) chain.method('top', scaledPxWithOffset(lengthNumber(inset.top, ctx), ctx, offset.y))
    if (inset.bottom !== undefined) chain.method('bottom', scaledPx(lengthNumber(inset.bottom, ctx), ctx))
  } else {
    if (inset.top !== undefined) chain.method('top', scaledPxWithOffset(lengthNumber(inset.top, ctx), ctx, offset.y))
  }
}
