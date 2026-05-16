import type { DBox, DFlex, DNode, DStack } from '../../../compiler/design-ast.ts'
import { Align, FlowDirection, Justify, NodeKind } from '../../../compiler/design-ast.ts'
import { div } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { addSizing } from './sizing.ts'
import { addContainerStyles } from './styles.ts'
import { lengthExpr } from './values.ts'

export async function emitContainer(
  n: DFlex | DStack | DBox,
  ctx: GpuiEmitContext,
  indent: number,
  emitChild: (n: DNode, ctx: GpuiEmitContext, indent: number, parentDirection?: FlowDirection) => Promise<string>,
  parentDirection?: FlowDirection,
): Promise<string> {
  const chain = div(indent)
  const direction =
    n.kind === NodeKind.Flex
      ? FlowDirection.Row
      : n.kind === NodeKind.Stack
        ? FlowDirection.Column
        : undefined

  if (direction) {
    chain.method('flex')
    if (direction === FlowDirection.Column) chain.method('flex_col')
  }
  addSizing(chain, n, ctx, parentDirection)
  addNodeLayout(chain, n, ctx)
  // Padding on an empty container only exists in Figma as a hit-area hint
  // and never widens the visible box, so emitting it as real padding here
  // would inflate the GPUI box without any content using the space.
  const stylesNode = n.children.length === 0 ? { ...n, padding: undefined } : n
  addContainerStyles(chain, stylesNode, ctx)

  if (direction) {
    const flex = n as DFlex | DStack
    if (flex.wrap) chain.method('flex_wrap')
    if (flex.gap) chain.method('gap', lengthExpr(flex.gap, ctx))
    if (flex.align === Align.Center) chain.method('items_center')
    else if (flex.align === Align.End) chain.method('items_end')
    else chain.method('items_start')

    if (flex.justify === Justify.Center) chain.method('justify_center')
    else if (flex.justify === Justify.End) chain.method('justify_end')
    else if (flex.justify === Justify.SpaceBetween) chain.method('justify_between')
  }

  for (const child of n.children) {
    chain.child(await emitChild(child, ctx, indent + 2, direction))
  }
  return chain.toString()
}
