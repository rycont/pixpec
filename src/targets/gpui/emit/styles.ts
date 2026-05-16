import type { DBox, DFlex, DStack, LengthValue } from '../../../compiler/design-ast.ts'
import { StrokeAlign } from '../../../compiler/design-ast.ts'
import type { GpuiChain } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { num } from './rust.ts'
import { colorExpr, lengthExpr, lengthNumber } from './values.ts'

export function addContainerStyles(
  chain: GpuiChain,
  n: DFlex | DStack | DBox,
  ctx: GpuiEmitContext,
): void {
  if (n.background) chain.method('bg', colorExpr(n.background, ctx))

  // Figma's stroke `align: "inside"` paints the border on top of the content
  // area without growing the box. GPUI's `.border()` instead adds the border
  // to the box's outer extents, so for inside-aligned borders we shrink the
  // padding by the border width to land at Figma's visual size.
  const borderInset = n.border?.align === StrokeAlign.Inside ? perSideBorder(n.border.width, ctx) : zeroInset()
  if (n.border) {
    const w = n.border.width
    if (isPerSideWidth(w)) {
      chain.method('border_t', lengthExpr(w.top, ctx))
      chain.method('border_r', lengthExpr(w.right, ctx))
      chain.method('border_b', lengthExpr(w.bottom, ctx))
      chain.method('border_l', lengthExpr(w.left, ctx))
    } else {
      chain.method('border', lengthExpr(w, ctx))
    }
    chain.method('border_color', colorExpr(n.border.paint, ctx))
  }
  if (n.padding) {
    chain.method('pt', adjustedPadding(n.padding.top, borderInset.top, ctx))
    chain.method('pr', adjustedPadding(n.padding.right, borderInset.right, ctx))
    chain.method('pb', adjustedPadding(n.padding.bottom, borderInset.bottom, ctx))
    chain.method('pl', adjustedPadding(n.padding.left, borderInset.left, ctx))
  }
  if (n.cornerRadius && isLengthValue(n.cornerRadius)) {
    chain.method('rounded', lengthExpr(n.cornerRadius, ctx))
  }
  if (n.opacity !== undefined) chain.method('opacity', num(n.opacity))
  if (n.clip) chain.method('overflow_hidden')
}

function adjustedPadding(value: LengthValue, borderPx: number, ctx: GpuiEmitContext): string {
  if (borderPx <= 0) return lengthExpr(value, ctx)
  const adjusted = Math.max(0, lengthNumber(value, ctx) - borderPx)
  return lengthExpr({ kind: 'literal', value: { value: adjusted, unit: 'px' } }, ctx)
}

function perSideBorder(
  width: LengthValue | { top: LengthValue; right: LengthValue; bottom: LengthValue; left: LengthValue },
  ctx: GpuiEmitContext,
): { top: number; right: number; bottom: number; left: number } {
  if (isPerSideWidth(width)) {
    return {
      top: lengthNumber(width.top, ctx),
      right: lengthNumber(width.right, ctx),
      bottom: lengthNumber(width.bottom, ctx),
      left: lengthNumber(width.left, ctx),
    }
  }
  const v = lengthNumber(width, ctx)
  return { top: v, right: v, bottom: v, left: v }
}

function zeroInset() {
  return { top: 0, right: 0, bottom: 0, left: 0 }
}

function isPerSideWidth(
  value: LengthValue | { top: LengthValue; right: LengthValue; bottom: LengthValue; left: LengthValue },
): value is { top: LengthValue; right: LengthValue; bottom: LengthValue; left: LengthValue } {
  return typeof value === 'object' && value !== null && 'top' in value && 'right' in value
}

function isLengthValue(value: unknown): value is LengthValue {
  if (typeof value === 'string') return true
  if (!value || typeof value !== 'object') return false
  return 'kind' in value
}
