/**
 * DText → Slint `PixpecText { ... }`.
 *
 * `PixpecText` is a generated component (build-text.ts produces it from
 * each font's meta.toml [yShift] table) that wraps `Text` in a Rectangle
 * with explicit y offset. It is the Slint software-renderer equivalent
 * of panda's runtime `transform: translateY(...)` Y-shift correction —
 * Slint software renderer doesn't support 2D transforms, so the offset
 * goes onto the Text's `y` inside a non-layout wrapper. Encapsulating
 * the wrapper inside PixpecText keeps the emitter output a single
 * element per text node.
 *
 * textStyleRef handling: when set to a clean dot-path, font-* props
 * resolve to struct-field accesses on Tokens.<id>. compile() currently
 * passes through figma's raw textStyleId ("S:abc...") which doesn't
 * match any tokens.slint identifier — that's a compile.ts gap (a
 * textStyleMap analogue to tokenMap is missing) and emitter just falls
 * through to per-axis emission until that gap closes.
 */

import { type DText, TextAutoResize } from '../../compiler/design-ast.ts'
import { elem, setProp, type SElement } from './ir.ts'
import { sizeExpr, colorExpr, tokenIdent } from './values.ts'

export function lowerText(t: DText): SElement {
  const e = elem('PixpecText')
  setProp(e, 'text', JSON.stringify(t.content))

  const SEMANTIC_REF = /^[a-zA-Z][a-zA-Z0-9.]*$/
  const useStyleRef = !!t.textStyleRef && SEMANTIC_REF.test(t.textStyleRef)

  if (useStyleRef) {
    const ref = `Tokens.${tokenIdent(t.textStyleRef!)}`
    setProp(e, 'font-family', t.fontFamily ? JSON.stringify(t.fontFamily) : `${ref}.font-family`)
    setProp(e, 'font-size', t.fontSize ? sizeExpr(t.fontSize) : `${ref}.font-size`)
    setProp(e, 'font-weight', t.fontWeight !== undefined ? String(t.fontWeight) : `${ref}.font-weight`)
  } else {
    setProp(e, 'font-family', t.fontFamily ? JSON.stringify(t.fontFamily) : undefined)
    setProp(e, 'font-size', sizeExpr(t.fontSize))
    setProp(e, 'font-weight', t.fontWeight !== undefined ? String(t.fontWeight) : undefined)
  }

  setProp(e, 'text-color', colorExpr(t.color))

  // figma autoResize=fixed-width / fixed-both → forward the explicit text
  // box width to PixpecText so the inner Text renders at that size and the
  // wrapper Rectangle hugs to it (matches figma's layout where the
  // textbox width drives the parent flex/box's hug width).
  if (t.autoResize === TextAutoResize.FixedWidth || t.autoResize === TextAutoResize.FixedBoth) {
    setProp(e, 'text-width', `${t.width}px`)
  }

  return e
}
