/**
 * DFlex / DStack → Slint `Rectangle { HorizontalLayout|VerticalLayout {} }`.
 *
 * Two-element pattern: Rectangle owns the visual properties (background,
 * border-radius), the layout owns the auto-layout properties (padding,
 * spacing, alignment). HorizontalLayout / VerticalLayout don't render
 * visuals, so the wrapping Rectangle is required whenever the container
 * has any visual styling — which is typical in design systems.
 */

import {
  type DFlex,
  type DStack,
  type DBox,
  type DNode,
  type Size,
  Align,
  Justify,
  Sizing,
  FlowDirection,
} from '../../compiler/design-ast.ts'
import { elem, setProp, addChild, type SElement } from './ir.ts'
import { sizeExpr, colorExpr } from './values.ts'

/** Translate figma Sizing semantics → Slint Rectangle sizing properties.
 *  fixed: explicit width/height. fill: horizontal-/vertical-stretch:1.
 *  hug:   nothing (Slint sizes the Rectangle from its children's natural
 *         sizes, matching figma's hug behaviour).
 *  Shared with lower-box.ts; exported here to keep size logic in one
 *  module. */
export function applySizing(r: SElement, node: DFlex | DStack | DBox): void {
  const sh = node.sizing?.horizontal
  const sv = node.sizing?.vertical
  if (sh === Sizing.Fixed && node.width) setProp(r, 'width', sizeExpr(node.width))
  else if (sh === Sizing.Fill) setProp(r, 'horizontal-stretch', '1')
  if (sv === Sizing.Fixed && node.height) setProp(r, 'height', sizeExpr(node.height))
  else if (sv === Sizing.Fill) setProp(r, 'vertical-stretch', '1')
}

// Y-shift baseline correction is no longer the parent layout's concern —
// it's encapsulated inside `PixpecText` (see build-text.ts and lower-text.ts).
// emitFlexLike emits figma's padding/spacing/alignment verbatim.

function alignToSlint(a: Align | undefined, j: Justify | undefined): string | undefined {
  // HorizontalLayout/VerticalLayout's `alignment` is a single enum mixing
  // main-axis distribution. Map figma's main(justify)+cross(align) onto
  // slint's nearest equivalent. start/center/end map directly; space-between
  // maps to `space-between`.
  if (j === Justify.SpaceBetween) return 'space-between'
  switch (j) {
    case Justify.Start: return 'start'
    case Justify.Center: return 'center'
    case Justify.End: return 'end'
  }
  return a === undefined ? undefined : a === Align.Start ? 'start' : a === Align.End ? 'end' : 'center'
}

function emitContainerVisual(node: DFlex | DStack): SElement {
  const r = elem('Rectangle')
  applySizing(r, node)
  setProp(r, 'background', colorExpr(node.background))
  if (node.cornerRadius && !('tl' in node.cornerRadius)) {
    setProp(r, 'border-radius', sizeExpr(node.cornerRadius as Size))
  }
  return r
}

function emitPadding(layout: SElement, pad: DFlex['padding']): void {
  if (!pad) return
  setProp(layout, 'padding-left', sizeExpr(pad.left))
  setProp(layout, 'padding-right', sizeExpr(pad.right))
  setProp(layout, 'padding-top', sizeExpr(pad.top))
  setProp(layout, 'padding-bottom', sizeExpr(pad.bottom))
}

export function lowerFlexLike(
  node: DFlex | DStack,
  lowerNode: (n: DNode) => SElement,
): SElement {
  const visual = emitContainerVisual(node)
  const layout = elem(node.direction === FlowDirection.Column ? 'VerticalLayout' : 'HorizontalLayout')
  emitPadding(layout, node.padding)
  setProp(layout, 'spacing', sizeExpr(node.gap))
  setProp(layout, 'alignment', alignToSlint(node.align, node.justify))
  for (const c of node.children) addChild(layout, lowerNode(c))
  addChild(visual, layout)
  return visual
}
