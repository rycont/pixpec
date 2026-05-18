import type { AxisPosition, DNode } from '../../../compiler/design-ast.ts'
import type { GpuiChain } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { lengthExpr, lengthNumber, scaledPx, scaledPxWithOffset } from './values.ts'

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
    chain.method(startKey, insetExpr(axis.start, ctx, offset))
  }
  if (axis.end !== undefined) {
    chain.method(endKey, insetExpr(axis.end, ctx, undefined))
  }
}

function insetExpr(
  value: import('../../../compiler/design-ast.ts').LengthValue,
  ctx: GpuiEmitContext,
  offset: number | undefined,
): string {
  // Insets need the offset (render-bounds shift) baked into px values.
  // For % units the offset isn't meaningful — pass through lengthExpr.
  const isPctLiteral =
    !!value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'literal' &&
    (value as { value?: { unit?: unknown } }).value?.unit === '%'
  if (isPctLiteral || offset === undefined) return lengthExpr(value, ctx)
  return scaledPxWithOffset(lengthNumber(value, ctx), ctx, offset)
}
