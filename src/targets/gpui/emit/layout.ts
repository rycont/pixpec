import type { AxisPosition, DNode } from '../../../compiler/design-ast.ts'
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
  chain.method('absolute')
  applyAxis(chain, n.absolute.horizontal, 'left', 'right', ctx, offset.x)
  applyAxis(chain, n.absolute.vertical, 'top', 'bottom', ctx, offset.y)
}

function applyAxis(
  chain: GpuiChain,
  axis: AxisPosition | undefined,
  startKey: 'left' | 'top',
  endKey: 'right' | 'bottom',
  ctx: GpuiEmitContext,
  offset: number | undefined,
): void {
  if (!axis || axis.kind !== 'inset') return
  if (axis.start !== undefined) {
    chain.method(startKey, scaledPxWithOffset(lengthNumber(axis.start, ctx), ctx, offset))
  }
  if (axis.end !== undefined) {
    chain.method(endKey, scaledPx(lengthNumber(axis.end, ctx), ctx))
  }
}
