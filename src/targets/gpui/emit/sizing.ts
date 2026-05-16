import type { DBox, DFlex, DStack } from '../../../compiler/design-ast.ts'
import { FlowDirection, Sizing } from '../../../compiler/design-ast.ts'
import type { GpuiChain } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { isAxisLength, lengthExpr } from './values.ts'

export function addSizing(
  chain: GpuiChain,
  n: DFlex | DStack | DBox,
  ctx: GpuiEmitContext,
  parentDirection?: FlowDirection,
): void {
  const fillHorizontal = n.width === Sizing.Fill
  const fillVertical = n.height === Sizing.Fill
  const crossAxisFillHorizontal = parentDirection === FlowDirection.Column && fillHorizontal
  const crossAxisFillVertical = parentDirection === FlowDirection.Row && fillVertical
  const mainAxisFillHorizontal = parentDirection === FlowDirection.Row && fillHorizontal
  const mainAxisFillVertical = parentDirection === FlowDirection.Column && fillVertical

  // Fill semantics:
  // - Main-axis fill in a flex parent ≡ `flex: 1 1 0` (grab remaining space).
  //   Containers want this so a wide main panel claims the slack alongside
  //   a hug-sized sidebar.
  // - Cross-axis fill stretches via `align_self: stretch`.
  // - Fill outside a flex parent ≡ 100% of parent.
  // - Hug / fixed sizes inside a flex parent get `flex_shrink_0` so a sibling
  //   marked Fill cannot steal pixels by squeezing them below their intrinsic
  //   size — Figma autolayout never shrinks Hug children to satisfy Fill.
  if (mainAxisFillHorizontal) chain.method('flex_1')
  else if (fillHorizontal && !crossAxisFillHorizontal) chain.method('w_full')
  else {
    if (isAxisLength(n.width)) chain.method('w', lengthExpr(n.width, ctx))
    if (parentDirection === FlowDirection.Row) chain.method('flex_shrink_0')
  }

  if (mainAxisFillVertical) chain.method('flex_1')
  else if (fillVertical && !crossAxisFillVertical) chain.method('h_full')
  else {
    if (isAxisLength(n.height)) chain.method('h', lengthExpr(n.height, ctx))
    if (parentDirection === FlowDirection.Column) chain.method('flex_shrink_0')
  }

  if (n.minWidth) chain.method('min_w', lengthExpr(n.minWidth, ctx))
  if (n.maxWidth) chain.method('max_w', lengthExpr(n.maxWidth, ctx))
  if (n.minHeight) chain.method('min_h', lengthExpr(n.minHeight, ctx))
  if (n.maxHeight) chain.method('max_h', lengthExpr(n.maxHeight, ctx))

  if (crossAxisFillVertical || crossAxisFillHorizontal) {
    chain.styleAssign('align_self', 'Some(gpui::AlignItems::Stretch)')
  }
}
