/**
 * DBox → Slint `Rectangle { ... }`.
 *
 * DBox has no auto-layout — children are absolute-positioned. Slint
 * Rectangle stacks bare children at (0,0) overlapping, which is rarely
 * what the design intends. Proper absolute positioning (DNode.inset /
 * anchor) is deferred until the first DBox case shows up in breakdown.
 */

import { type DBox, type DNode, type Size, Positioning } from '../../compiler/design-ast.ts'
import { elem, setProp, addChild, type SElement } from './ir.ts'
import { sizeExpr, colorExpr } from './values.ts'
import { applySizing } from './lower-flex.ts'

/** Emit the child's bbox-derived inset onto x/y. compile() flags both
 *  layoutPositioning=ABSOLUTE (autolayout opt-out) AND children of a
 *  non-autolayout parent (where x/y in parent coordinates is the only
 *  positioning information available) as Positioning.Absolute, so the
 *  emitter just trusts the IR. */
function applyAbsoluteInset(child: SElement, n: DNode): void {
  if (n.positioning !== Positioning.Absolute || !n.inset) return
  if (n.inset.left !== undefined) setProp(child, 'x', `${n.inset.left}px`)
  if (n.inset.top !== undefined) setProp(child, 'y', `${n.inset.top}px`)
}

export function lowerBox(
  node: DBox,
  lowerNode: (n: DNode) => SElement,
): SElement {
  const r = elem('Rectangle')
  applySizing(r, node)
  setProp(r, 'background', colorExpr(node.background))
  if (node.cornerRadius && !('tl' in node.cornerRadius)) {
    setProp(r, 'border-radius', sizeExpr(node.cornerRadius as Size))
  }
  for (const c of node.children) {
    const sub = lowerNode(c)
    applyAbsoluteInset(sub, c)
    addChild(r, sub)
  }
  return r
}
