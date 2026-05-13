import type { DBox, DFlex, DStack } from '../../../compiler/design-ast.ts'
import { FlowDirection, Sizing } from '../../../compiler/design-ast.ts'
import type { GpuiChain } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { sizeExpr } from './values.ts'

export function addSizing(
  chain: GpuiChain,
  n: DFlex | DStack | DBox,
  ctx: GpuiEmitContext,
  parentDirection?: FlowDirection,
): void {
  const fillHorizontal = n.sizing?.horizontal === Sizing.Fill
  const fillVertical = n.sizing?.vertical === Sizing.Fill
  const crossAxisFillHorizontal = parentDirection === FlowDirection.Column && fillHorizontal
  const crossAxisFillVertical = parentDirection === FlowDirection.Row && fillVertical

  if (fillHorizontal && !crossAxisFillHorizontal) chain.method('w_full')
  else if ((n.sizing?.horizontal ?? Sizing.Fixed) === Sizing.Fixed && n.width) chain.method('w', sizeExpr(n.width, ctx))

  if (fillVertical && !crossAxisFillVertical) chain.method('h_full')
  else if ((n.sizing?.vertical ?? Sizing.Fixed) === Sizing.Fixed && n.height) chain.method('h', sizeExpr(n.height, ctx))

  if (n.minWidth) chain.method('min_w', sizeExpr(n.minWidth, ctx))
  if (n.maxWidth) chain.method('max_w', sizeExpr(n.maxWidth, ctx))
  if (n.minHeight) chain.method('min_h', sizeExpr(n.minHeight, ctx))
  if (n.maxHeight) chain.method('max_h', sizeExpr(n.maxHeight, ctx))

  if (
    crossAxisFillVertical ||
    crossAxisFillHorizontal
  ) {
    chain.styleAssign('align_self', 'Some(gpui::AlignItems::Stretch)')
  }
}
