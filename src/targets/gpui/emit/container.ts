import type { DBox, DFlex, DNode, DStack } from '../../../compiler/design-ast.ts'
import { Align, FlowDirection, Justify, NodeKind } from '../../../compiler/design-ast.ts'
import { div } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { pad } from './rust.ts'
import { addSizing } from './sizing.ts'
import { addContainerStyles } from './styles.ts'
import { colorExpr, lengthExpr, lengthNumber } from './values.ts'

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
  let stylesNode = n.children.length === 0 ? { ...n, padding: undefined } : n
  // Figma's `cornerSmoothing > 0` paints a continuous-curvature ("squircle")
  // corner that GPUI's `rounded()` does not reproduce — corner placement
  // differs by 1-2px at the curve which snowballs in pixel-diff verification.
  // Route the bg + rounded through a runtime-painted squircle path overlay
  // (see pixpec_squircle_bg in capture.ts main.rs); stripping those fields
  // from the styles call lets the standard div be just the layout container.
  const smoothing = (n as { cornerSmoothing?: number }).cornerSmoothing ?? 0
  const radiusValue = n.cornerRadius
  const hasUniformRadius = !!radiusValue && (typeof radiusValue === 'string' || (typeof radiusValue === 'object' && 'kind' in radiusValue))
  const useSquircleBg = smoothing > 0 && hasUniformRadius && !!n.background
  let squircleBg: { radius: number; smoothing: number; color: string } | undefined
  if (useSquircleBg) {
    stylesNode = { ...stylesNode, background: undefined, cornerRadius: undefined }
    // GPUI's `absolute()` already establishes a positioning context for
    // descendants — appending `.relative()` would silently override that and
    // collapse the node back into normal flow, breaking any absolutely-
    // positioned child placement (e.g. slider handles).
    if (!n.absolute) chain.method('relative')
    squircleBg = {
      radius: lengthNumber(radiusValue as Parameters<typeof lengthNumber>[0], ctx),
      smoothing,
      color: colorExpr(n.background!, ctx),
    }
  }
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

  if (squircleBg) {
    chain.child(
      `${pad(indent + 2)}super::pixpec_squircle_bg(${rustFloat(squircleBg.radius)}, ${rustFloat(squircleBg.smoothing)}, ${squircleBg.color})`,
    )
  }
  for (const child of n.children) {
    chain.child(await emitChild(child, ctx, indent + 2, direction))
  }
  return chain.toString()
}

function rustFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${+value.toFixed(6)}`
}
