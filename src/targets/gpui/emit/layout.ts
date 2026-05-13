import type { DNode } from '../../../compiler/design-ast.ts'
import { Anchor, Positioning } from '../../../compiler/design-ast.ts'
import type { GpuiChain } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { scaledPx, scaledPxWithOffset } from './values.ts'

export function addNodeLayout(
  chain: GpuiChain,
  n: DNode,
  ctx: GpuiEmitContext,
  offset: { x?: number; y?: number } = {},
): void {
  if (n.positioning !== Positioning.Absolute) return

  const inset = n.inset ?? {}
  chain.method('absolute')
  if (typeof inset.left === 'number') chain.method('left', scaledPxWithOffset(inset.left, ctx, offset.x))
  if (typeof inset.top === 'number') chain.method('top', scaledPxWithOffset(inset.top, ctx, offset.y))
  if (
    n.anchor?.horizontal === Anchor.Stretch &&
    typeof inset.right === 'number'
  ) {
    chain.method('right', scaledPx(inset.right, ctx))
  }
  if (
    n.anchor?.vertical === Anchor.Stretch &&
    typeof inset.bottom === 'number'
  ) {
    chain.method('bottom', scaledPx(inset.bottom, ctx))
  }
}
