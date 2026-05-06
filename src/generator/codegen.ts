/**
 * IR → React + PandaCSS JSX codegen using TypeScript factory + printer.
 *
 *   - Type-safe AST construction (ts.factory.*)
 *   - Printer handles escaping, indentation, JSX text/expression boundaries
 *   - No string concatenation
 *
 * Phase 0 mappings:
 *   IRComponent → <Name {...props} />
 *   IRFrame     → <div style={{...}}>{children}</div>
 *   IRText      → <span style={{...}}>content</span>
 *   IRVector / IRUnknown → placeholder div
 *
 * fromInstance() runs in hydrate() pass before codegen.
 */
import * as ts from 'typescript'
import { getSvgPath } from 'figma-squircle'
import type { Component } from '../types.ts'
import type { IRNode, IRComponent, IRFrame, IRText, IRVector, IRShape, IRImage, IRUnknown } from './ir.ts'

const f = ts.factory

interface IRComponentRaw extends IRComponent {
  raw: unknown
}

/** Apply each registered component's fromInstance to fill .props. Mutates.
 * fromInstance is allowed to return `undefined` for missing-in-figma fields;
 * we drop those keys here so the rendering component naturally falls back to
 * its declared `defaults` at runtime.
 * If the component declares `defaults`, copy it to IR — codegen will elide
 * instance props whose values match the declared defaults. Without defaults
 * declared, NO elision happens (safe fallback for un-migrated components). */
export function hydrate(node: IRNode, components: Component<unknown>[]): IRNode {
  if (node.kind === 'component') {
    const c = node as IRComponentRaw
    const comp = components.find((x) => x.name === c.componentName)
    if (comp?.figma) {
      const raw = comp.figma.fromInstance(c.raw as never) as Record<string, unknown>
      c.props = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))
    }
    if (comp?.defaults) c.defaultProps = comp.defaults as Record<string, unknown>
    delete (c as Partial<IRComponentRaw>).raw
  }
  if (node.kind === 'frame') for (const ch of node.children) hydrate(ch, components)
  return node
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** JS value → ts AST expression. Handles primitives, arrays, plain objects. */
function valueToExpr(v: unknown): ts.Expression {
  if (v === null) return f.createNull()
  if (v === undefined) return f.createIdentifier('undefined')
  if (typeof v === 'boolean') return v ? f.createTrue() : f.createFalse()
  if (typeof v === 'number') return f.createNumericLiteral(v)
  if (typeof v === 'string') return f.createStringLiteral(v)
  if (Array.isArray(v)) return f.createArrayLiteralExpression(v.map(valueToExpr))
  if (typeof v === 'object') {
    const props = Object.entries(v as Record<string, unknown>).map(([k, val]) => {
      const name = IDENT_RE.test(k) ? f.createIdentifier(k) : f.createStringLiteral(k)
      return f.createPropertyAssignment(name, valueToExpr(val))
    })
    return f.createObjectLiteralExpression(props, false)
  }
  return f.createStringLiteral(String(v))
}

/** Build JSX attributes; identifier-safe keys go inline, rest go via spread.
 * String values render as `prop="value"` (no curly braces) — matches the
 * idiomatic JSX style. Other types (number, boolean, object) use `{...}`. */
function attrsFromObject(obj: Record<string, unknown>): ts.JsxAttributeLike[] {
  const inline: ts.JsxAttribute[] = []
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (IDENT_RE.test(k)) {
      const initializer: ts.JsxAttributeValue = typeof v === 'string'
        ? f.createStringLiteral(v)
        : f.createJsxExpression(undefined, valueToExpr(v))
      inline.push(f.createJsxAttribute(f.createIdentifier(k), initializer))
    } else {
      rest[k] = v
    }
  }
  if (Object.keys(rest).length) {
    inline.push(f.createJsxSpreadAttribute(valueToExpr(rest)) as ts.JsxAttributeLike as ts.JsxAttribute)
  }
  return inline
}

/** Deep-equal for primitives + plain JSON-shaped objects/arrays. */
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const ka = Object.keys(a), kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return false
}

function emitComponent(n: IRComponent, ctx: CodegenCtx, _parent: ParentCtx = { dir: 'none', mainSizing: 'fixed' }): ts.JsxChild {
  // Elide props that match the component-set's default — figma's
  // `componentPropertyDefinitions[name].defaultValue` semantically equals
  // "what you'd get if you didn't override it." Cuts visual noise on
  // generated JSX without losing fidelity.
  const props = n.defaultProps
    ? Object.fromEntries(Object.entries(n.props).filter(([k, v]) => !deepEq(v, n.defaultProps![k])))
    : n.props
  const inner = f.createJsxSelfClosingElement(
    f.createIdentifier(n.componentName),
    undefined,
    f.createJsxAttributes(attrsFromObject(props)),
  )
  // Layout wrapping (flex-shrink:0 / flex:1 / alignSelf:stretch) is applied
  // by emitNode AFTER plugin emitWrap so it's always the outermost layer —
  // the outer span is the one the parent flex container sees, so its
  // shrink/grow behavior must not be hidden by plugin wrappers.
  let wrapped: ts.JsxChild = inner
  // figma rotation (counterclockwise degrees) → CSS rotate (clockwise positive).
  // Wrap with inline-flex div so rotate doesn't affect parent layout.
  if (n.rotation !== undefined) {
    // The rotation wrap holds the PRE-rotation box (figma `.width`×`.height`).
    // Outer layout-wrap reserves the post-rotation axis-aligned bbox; the
    // rotation here just paints the inner box at that visual orientation.
    //
    // transform-origin defaults to 50%/50%, which puts the rotated visual off
    // the layout slot when w ≠ h. Use top-left origin (0 0) and a translate
    // to bring the post-rotation bbox back to (0,0) of the slot:
    //   corners → rotate → minX, minY → translate(-minX, -minY)
    // This places the rotated visual flush with the layout-wrap span's box,
    // matching figma's render of rotated children inside autolayout.
    const css = (-n.rotation) * Math.PI / 180  // CSS rotate is clockwise; figma counterclockwise

    const w0 = typeof n.width === 'number' ? n.width : 0
    const h0 = typeof n.height === 'number' ? n.height : 0
    const cos = Math.cos(css), sin = Math.sin(css)
    const corners: [number, number][] = [[0, 0], [w0, 0], [w0, h0], [0, h0]]
    const rotated = corners.map(([x, y]): [number, number] => [x * cos - y * sin, x * sin + y * cos])
    const minX = Math.min(...rotated.map((p) => p[0]))
    const minY = Math.min(...rotated.map((p) => p[1]))
    // Thin rotated shape (post-rotation w ≤ 1 css) at sub-pixel x in flex
    // → Skia HTML rasterizer snaps to integer raw px. Empirically translate
    // half a css px LESS than the geometric `-minX` puts the rendered ink at
    // figma's sub-pixel position (verified via SnapGridProbe + Gen_3707_4081
    // divider). Geometric: translate(1, 0) → snap to css 63. Adjusted:
    // translate(0.5, 0) → ink at css 62.5 = match figma. The trick works only
    // for thin shapes; thicker rotated shapes don't snap.
    const rotPostW = Math.abs(w0 * Math.cos(css)) + Math.abs(h0 * Math.sin(css))
    const isThin = rotPostW <= 1.01
    const tx = isThin ? -minX - 0.5 : -minX
    const rotateStyle: Record<string, unknown> = {
      display: 'inline-flex',
      alignSelf: 'flex-start',
      // inline-flex sits on baseline by default → ~18 css px Y offset inside an
      // inline-block layout-wrap parent. `vertical-align: top` aligns the
      // rotation box to the parent's content-top, matching figma's render.
      verticalAlign: 'top',
      transformOrigin: '0 0',
      transform: `translate(${px2rem(tx, ctx.remBase)}, ${px2rem(-minY, ctx.remBase)}) rotate(${-n.rotation}deg)`,
    }
    if (typeof n.width === 'number') rotateStyle.width = px2rem(n.width, ctx.remBase)
    if (typeof n.height === 'number') rotateStyle.height = px2rem(n.height, ctx.remBase)
    const open = f.createJsxOpeningElement(
      f.createIdentifier('div'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('style'),
          f.createJsxExpression(undefined, valueToExpr(rotateStyle))),
      ]),
    )
    const close = f.createJsxClosingElement(f.createIdentifier('div'))
    return f.createJsxElement(open, [wrapped], close)
  }
  return wrapped
}

function emitFrame(n: IRFrame, ctx: CodegenCtx, parent: ParentCtx = { dir: 'none', mainSizing: 'fixed' }): ts.JsxElement {
  const parentDir = parent.dir
  const flexDir = n.layout.direction === 'none' ? null : n.layout.direction
  const styles: Record<string, unknown> = {}
  // FILL semantics depend on parent main-axis: same axis → flex:1; cross axis → alignSelf:stretch.
  // BUT if parent's main-axis is HUG, "fill" along that axis is meaningless in figma
  // (HUG sizes to content), so collapse to HUG behaviour (no flex:1) — matches figma render.
  const fillStyle = (axis: 'h' | 'v'): 'main' | 'cross' | null => {
    // No IR parent → assume the harness wrapper (boxWrapper) is row-flex.
    // Root FILL-H → flex:1, FILL-V → alignSelf:stretch. This preserves figma's
    // FILL semantic in CSS without baking the resolved pixel dim.
    if (parentDir === 'none') return axis === 'h' ? 'main' : 'cross'
    const parentMainIsH = parentDir === 'row'
    const isMain = (axis === 'h' && parentMainIsH) || (axis === 'v' && !parentMainIsH)
    if (isMain && parent.mainSizing === 'hug') return null
    return isMain ? 'main' : 'cross'
  }
  // Auto-layout containers map to panda's Flex (row) / Stack (column) / Box.
  // Each pattern's intrinsic default matches its name — Flex defaults to
  // flex-direction:row, Stack defaults to column. Skip emitting `direction`
  // when it matches the pattern's default.
  // Token-aware emission: when a styled property is bound to a figma variable,
  // emit the panda token path (e.g. 'spacing.200', 'background.standard.primary')
  // instead of raw px/hex. Resolves via ctx.tokenMap (figma var id → panda path).
  const tids = n.tokenIds || {}
  if (flexDir) {
    // direction omitted: Flex pattern defaults to row, Stack to column —
    // and we always pair (row→Flex, column→Stack), so the prop is redundant.
    // Always emit align/justify — CSS flex default for align-items is `stretch`
    // (NOT `start`), so omitting figma's `start` would leak `stretch` onto
    // children that would otherwise be intrinsic-sized. Same risk for justify
    // is smaller (default `start` matches figma's MIN), but emit for symmetry.
    styles.align = n.layout.alignItems
    // figma SPACE_BETWEEN with a single child renders as "center" (figma
    // distributes equal space on both sides). CSS flex `space-between` with
    // a single child collapses to `start`, so it would shift the child
    // left by (frameW - childW)/2 vs figma. Substitute when only 1 child.
    const visibleChildren = n.children.filter((c) => !c.absolute)
    styles.justify =
      n.layout.justifyContent === 'space-between' && visibleChildren.length === 1
        ? 'center'
        : n.layout.justifyContent
    // Always emit gap (even when 0) — Stack pattern in panda has default
    // gap='8px' which would silently apply when figma says 0.
    styles.gap = resolveValue(n.layout.gap, tids.gap, ctx.tokenMap)
    // figma layoutWrap=WRAP → flex-wrap:wrap. counterAxisSpacing maps to
    // rowGap (horizontal flow) or columnGap (vertical flow). The single
    // `gap` property emitted above sets BOTH axes; override the wrap-axis
    // gap when figma specifies a different counter-gap.
    if (n.layout.wrap) {
      styles.flexWrap = 'wrap'
      const cg = n.layout.counterGap
      if (typeof cg === 'number' && cg !== n.layout.gap) {
        if (n.layout.direction === 'row') styles.rowGap = cg
        else if (n.layout.direction === 'column') styles.columnGap = cg
      }
    }
  }
  // figma allows degenerate frames where padding-sum > FIXED size on an
  // axis (e.g. h=4 with padTop=10 padBottom=10). Figma clips and renders at
  // the FIXED size; CSS clamps box dim up to padding-sum and can't be
  // overridden by box-sizing/max-height/overflow. Drop padding on the
  // offending axis when it would be degenerate. Logged for diagnostics.
  const dropV = n.layout.sizingV === 'fixed' && typeof n.height === 'number'
    && (n.layout.paddingTop + n.layout.paddingBottom > n.height)
  const dropH = n.layout.sizingH === 'fixed' && typeof n.width === 'number'
    && (n.layout.paddingLeft + n.layout.paddingRight > n.width)
  if (n.layout.paddingTop && !dropV) styles.paddingTop = resolveValue(n.layout.paddingTop, tids.paddingTop, ctx.tokenMap)
  if (n.layout.paddingRight && !dropH) styles.paddingRight = resolveValue(n.layout.paddingRight, tids.paddingRight, ctx.tokenMap)
  if (n.layout.paddingBottom && !dropV) styles.paddingBottom = resolveValue(n.layout.paddingBottom, tids.paddingBottom, ctx.tokenMap)
  if (n.layout.paddingLeft && !dropH) styles.paddingLeft = resolveValue(n.layout.paddingLeft, tids.paddingLeft, ctx.tokenMap)
  // FIXED → explicit figma resolved width/height (CSS default stretch != figma).
  // FILL → flex:1 (main) or alignSelf:stretch (cross). HUG → omit (intrinsic).
  // At root (parent.dir === 'none') there is no enclosing flex container in IR,
  // but the test harness wraps with boxWrapper (inline-flex row). Treat the
  // wrapper as a row-flex parent so FILL-H → flex:1, FILL-V → alignSelf:stretch.
  // This keeps the generated JSX semantically responsive (no fixed-px regression).
  if (n.layout.sizingH === 'fill') {
    const r = fillStyle('h')
    // `minWidth: 0` lets flex children shrink below their intrinsic min-content
    // (figma's autolayout doesn't enforce min-content, but CSS flexbox defaults
    // to `min-width: auto` which can push children to overflow their parent).
    if (r === 'main') { styles.flex = 1; styles.minWidth = 0 }
    else if (r === 'cross') { styles.alignSelf = 'stretch'; styles.minWidth = 0 }
  } else if (n.layout.sizingH === 'fixed' && n.width !== undefined) {
    styles.width = n.width
    // figma's FIXED sizing means "this dim is the truth" even if padding +
    // children would normally push the flex container larger. Override CSS
    // flex auto-min-size so the explicit dim wins.
    styles.minWidth = 0
  }
  if (n.layout.sizingV === 'fill') {
    const r = fillStyle('v')
    if (r === 'main') { styles.flex = 1; styles.minHeight = 0 }
    else if (r === 'cross') { styles.alignSelf = 'stretch'; styles.minHeight = 0 }
  } else if (n.layout.sizingV === 'fixed' && n.height !== undefined) {
    styles.height = n.height
    styles.minHeight = 0
  }
  if (n.background) styles.background = resolveValue(n.background, tids.background, ctx.tokenMap)
  // figma cornerSmoothing > 0 → render the rounded shape via clip-path with
  // figma-squircle's path. CSS `border-radius` is a circular arc; figma uses
  // a G2-continuous (smoothed) corner that fades into the side gradually.
  // For fixed-dim frames we can bake the path string at codegen time.
  //
  // CSS `clip-path: path(...)` uses px coordinates — when verify-mode scales
  // the box via html font-size, the px-coord path no longer covers the full
  // scaled box. Emit a per-frame SVG <clipPath clipPathUnits="objectBoundingBox">
  // whose path is normalized to 0..1, then reference via clip-path: url(#id).
  // SVG clipPath auto-scales to the box dim regardless of html font-size.
  let squirclePath: string | undefined
  let squircleClipId: string | undefined
  if (n.borderRadius && n.cornerSmoothing && n.cornerSmoothing > 0
      && typeof n.width === 'number' && typeof n.height === 'number') {
    squirclePath = getSvgPath({
      width: n.width, height: n.height,
      cornerRadius: n.borderRadius, cornerSmoothing: n.cornerSmoothing,
    }).replace(/\n/g, ' ').trim()
    squircleClipId = `pxp-clip-${n.figmaId.replace(/[^A-Za-z0-9]/g, '_')}`
    styles.clipPath = `url(#${squircleClipId})`
  } else if (n.borderRadius) {
    styles.borderRadius = n.borderRadius
  }
  // Stroke. Two cases:
  //   - non-squircle: use `inset boxShadow` (matches figma INSIDE alignment,
  //     no layout perturbation since `border` would expand the box).
  //   - squircle: clip-path cuts the inset shadow at the squircle edge, so
  //     corners lose their stroke pixels. Render an absolute SVG overlay
  //     with the same path stroked at 2× weight; clip-path clips the outer
  //     half, leaving exactly `strokeWeight` px of stroke inside the squircle.
  let strokeOverlay: ts.JsxChild | undefined
  if (n.strokeColor && n.strokeWeight) {
    if (squirclePath) {
      styles.position = 'relative'
      const overlayStyle = {
        position: 'absolute', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none' as const,
      }
      strokeOverlay = f.createJsxElement(
        f.createJsxOpeningElement(f.createIdentifier('svg'), undefined,
          f.createJsxAttributes([
            f.createJsxAttribute(f.createIdentifier('viewBox'),
              f.createStringLiteral(`0 0 ${n.width} ${n.height}`)),
            f.createJsxAttribute(f.createIdentifier('preserveAspectRatio'),
              f.createStringLiteral('none')),
            f.createJsxAttribute(f.createIdentifier('style'),
              f.createJsxExpression(undefined, valueToExpr(overlayStyle))),
          ])),
        [f.createJsxSelfClosingElement(f.createIdentifier('path'), undefined,
          f.createJsxAttributes([
            f.createJsxAttribute(f.createIdentifier('d'), f.createStringLiteral(squirclePath)),
            f.createJsxAttribute(f.createIdentifier('fill'), f.createStringLiteral('none')),
            f.createJsxAttribute(f.createIdentifier('stroke'), f.createStringLiteral(n.strokeColor)),
            f.createJsxAttribute(f.createIdentifier('strokeWidth'),
              f.createJsxExpression(undefined, valueToExpr(n.strokeWeight * 2))),
          ]))],
        f.createJsxClosingElement(f.createIdentifier('svg')),
      )
    } else {
      styles.boxShadow = `inset 0 0 0 ${px2rem(n.strokeWeight, ctx.remBase)} ${n.strokeColor}`
    }
  }
  if (n.clipsContent) styles.overflow = 'hidden'
  if (n.children?.some((c) => c.absolute)) styles.position = 'relative'

  // Pick the panda pattern: Flex (row) / Stack (column) / Box (no flex).
  // pattern's component name is tracked so we can emit the import.
  const tag =
    flexDir === 'row' ? 'Flex' :
    flexDir === 'column' ? 'Stack' :
    'Box'
  ctx.usedJsxPatterns.add(tag)
  const attrs = Object.keys(styles).length
    ? attrsFromObject(pandaize(styles, ctx.remBase))
    : []
  const open = f.createJsxOpeningElement(
    f.createIdentifier(tag), undefined, f.createJsxAttributes(attrs),
  )
  const close = f.createJsxClosingElement(f.createIdentifier(tag))
  // Build child parent ctx — main-axis sizing for this frame.
  const mainSizing: 'fixed' | 'hug' | 'fill' = n.layout.direction === 'row' ? n.layout.sizingH
    : n.layout.direction === 'column' ? n.layout.sizingV : 'fixed'
  const childParent: ParentCtx = { dir: n.layout.direction, mainSizing }
  const children = n.children.map((c) => emitNode(c, ctx, childParent))
  if (strokeOverlay) children.push(strokeOverlay)
  // Inject SVG <defs><clipPath> for squircle (objectBoundingBox so it scales
  // with the box dim regardless of html font-size).
  if (squircleClipId && squirclePath && typeof n.width === 'number' && typeof n.height === 'number') {
    const clipDef = f.createJsxElement(
      f.createJsxOpeningElement(f.createIdentifier('svg'), undefined,
        f.createJsxAttributes([
          f.createJsxAttribute(f.createIdentifier('width'), f.createStringLiteral('0')),
          f.createJsxAttribute(f.createIdentifier('height'), f.createStringLiteral('0')),
          f.createJsxAttribute(f.createIdentifier('style'),
            f.createJsxExpression(undefined, valueToExpr({ position: 'absolute' }))),
          f.createJsxAttribute(f.createIdentifier('aria-hidden'), f.createStringLiteral('true')),
        ])),
      [f.createJsxElement(
        f.createJsxOpeningElement(f.createIdentifier('defs'), undefined, f.createJsxAttributes([])),
        [f.createJsxElement(
          f.createJsxOpeningElement(f.createIdentifier('clipPath'), undefined,
            f.createJsxAttributes([
              f.createJsxAttribute(f.createIdentifier('id'), f.createStringLiteral(squircleClipId)),
              f.createJsxAttribute(f.createIdentifier('clipPathUnits'), f.createStringLiteral('objectBoundingBox')),
            ])),
          [f.createJsxSelfClosingElement(f.createIdentifier('path'), undefined,
            f.createJsxAttributes([
              f.createJsxAttribute(f.createIdentifier('d'), f.createStringLiteral(squirclePath)),
              f.createJsxAttribute(f.createIdentifier('transform'),
                f.createStringLiteral(`scale(${(1 / n.width).toFixed(8)} ${(1 / n.height).toFixed(8)})`)),
            ]))],
          f.createJsxClosingElement(f.createIdentifier('clipPath')),
        )],
        f.createJsxClosingElement(f.createIdentifier('defs')),
      )],
      f.createJsxClosingElement(f.createIdentifier('svg')),
    )
    children.push(clipDef)
  }
  let jsx: ts.JsxElement = f.createJsxElement(open, children, close)
  // figma rotation on FRAME — wrap in inline-block with transform.
  // Same approach as emitComponent rotation handling: pre-rotation box
  // + transform + translate to compensate origin shift.
  if (typeof n.rotation === 'number' && Math.abs(n.rotation) >= 0.01
      && typeof n.width === 'number' && typeof n.height === 'number') {
    const css = (-n.rotation) * Math.PI / 180
    const w0 = n.width, h0 = n.height
    const cos = Math.cos(css), sn = Math.sin(css)
    const corners: [number, number][] = [[0, 0], [w0, 0], [w0, h0], [0, h0]]
    const rotated = corners.map(([x, y]): [number, number] => [x * cos - y * sn, x * sn + y * cos])
    const minX = Math.min(...rotated.map((p) => p[0]))
    const minY = Math.min(...rotated.map((p) => p[1]))
    const maxX = Math.max(...rotated.map((p) => p[0]))
    const maxY = Math.max(...rotated.map((p) => p[1]))
    const rotW = maxX - minX
    const rotH = maxY - minY
    // Outer wrapper: post-rotation axis-aligned bbox dim. Inner rotation
    // origin (0,0) translated by (-minX,-minY) so painted bbox lines up
    // with wrapper's (0,0).
    const rotateStyle: Record<string, unknown> = {
      display: 'inline-block',
      verticalAlign: 'top',
      width: px2rem(rotW, ctx.remBase),
      height: px2rem(rotH, ctx.remBase),
    }
    const innerStyle: Record<string, unknown> = {
      transformOrigin: '0 0',
      transform: `translate(${px2rem(-minX, ctx.remBase)}, ${px2rem(-minY, ctx.remBase)}) rotate(${-n.rotation}deg)`,
    }
    // Apply transform to existing jsx by wrapping in another div (or merging).
    // Simpler: wrap jsx with inner-transform div, then outer-bbox div.
    const innerOpen = f.createJsxOpeningElement(
      f.createIdentifier('div'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('style'),
          f.createJsxExpression(undefined, valueToExpr(innerStyle))),
      ]),
    )
    const innerClose = f.createJsxClosingElement(f.createIdentifier('div'))
    const innerJsx = f.createJsxElement(innerOpen, [jsx], innerClose)
    const rotOpen = f.createJsxOpeningElement(
      f.createIdentifier('div'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('style'),
          f.createJsxExpression(undefined, valueToExpr(rotateStyle))),
      ]),
    )
    const rotClose = f.createJsxClosingElement(f.createIdentifier('div'))
    jsx = f.createJsxElement(rotOpen, [innerJsx], rotClose)
  }
  return jsx
}

function emitText(n: IRText, ctx: CodegenCtx, parent: ParentCtx = { dir: 'none', mainSizing: 'fixed' }): ts.JsxElement {
  const parentDir = parent.dir
  // If textStyleId matches a registered typography wrapper, use it.
  // The wrapper handles fontSize/lineHeight/weight/y-shift internally.
  // Live textStyleId format: "S:<hash>,<nodeSuffix>"; binding keys end in
  // ",", so binding key is a prefix of the live id.
  const wrapperName = n.textStyleId ? lookupTypoByPrefix(n.textStyleId, ctx.typographyMap) : undefined
  // Only constrain width when figma forces wrap; HUG = omit so intrinsic governs.
  // figma HUG text doesn't wrap (overflows parent if needed). Mirror that semantically.
  const isHug = n.autoResize === 'hug'
  // figma `paragraphSpacing`: distance between paragraphs (split by `\n`).
  // For typography-wrapper path, the wrapper itself reads paragraphSpacing
  // from `tokens/panda-tokens.ts` and emits per-paragraph blocks — we just
  // pass the raw string. For the fallback (raw <span>) path, codegen handles
  // the split here using `n.paragraphSpacing` from the IR.
  const paragraphs = n.content.split('\n')
  const needsParagraphBlocks = paragraphs.length > 1 && n.paragraphSpacing > 0
  // sizingH=FILL on text (autolayout sibling growing to fill row) → flex:1 (main axis) or
  // alignSelf:stretch (cross axis); explicit width breaks wrap behavior so omit it.
  // figma FILL on main axis is meaningless if parent is HUG (parent sizes to content,
  // so child has no space to grow into). Collapse to HUG so text uses intrinsic width.
  const parentHugMain = parent.mainSizing === 'hug'
  const fillMain = n.sizingH === 'fill' && parentDir === 'row' && !parentHugMain
  // Cross-axis FILL is independent of parent main sizing — even if parent
  // HUGs vertically (column flex main axis), the horizontal cross size is
  // determined by the widest child, and `alignSelf: stretch` on this text
  // makes it match that width. Without this, parent's `align="center"`
  // (figma counterAxisAlignItems=CENTER) would center the intrinsic-width
  // text instead of stretching it edge-to-edge.
  const fillCross = n.sizingH === 'fill' && parentDir === 'column'
  // Main-axis FILL is meaningless when parent is HUG main (no space to grow);
  // collapse to intrinsic.
  const collapsedFill = n.sizingH === 'fill' && parentDir === 'row' && parentHugMain
  const fixedWidth = !isHug && !fillMain && !fillCross && !collapsedFill ? n.width : undefined
  if (wrapperName) {
    ctx.usedTypography.add(wrapperName)
    const attrs: ts.JsxAttributeLike[] = []
    const wrapperStyles: Record<string, unknown> = {}
    if (fixedWidth !== undefined) wrapperStyles.width = fixedWidth
    if (fillMain) { wrapperStyles.flex = 1; wrapperStyles.minWidth = 0 }
    if (fillCross) wrapperStyles.alignSelf = 'stretch'
    // figma HUG: width = intrinsic max-content, parent overflows. CSS equivalent:
    // whiteSpace:nowrap (don't soft-wrap) + flex-shrink:0 (don't shrink below natural).
    // figma HUG: width = intrinsic max-content. `nowrap` prevents soft-wrap;
    // explicit `<br/>` (see textChildren) still creates the figma-authored
    // hard breaks regardless of nowrap.
    if (isHug) { wrapperStyles.whiteSpace = 'nowrap'; wrapperStyles.flexShrink = 0 }
    // Typography wrappers extend HTMLStyledProps<'span'>, so panda style props
    // (color, bg, etc.) pass through `splitCssProps` and merge into className
    // via css(). Prefer the bound token path (resolves to var(--colors-...))
    // — falls back to raw hex/rgba when no figma variable is bound.
    const colorTokenPath = n.tokenIds?.color ? ctx.tokenMap[n.tokenIds.color] : undefined
    if (colorTokenPath) {
      attrs.push(f.createJsxAttribute(f.createIdentifier('color'),
        f.createStringLiteral(colorTokenPath)))
    } else if (n.color) {
      wrapperStyles.color = n.color
    }
    // figma can override fontName.style on a TEXT instance independently of
    // its bound textStyle (designer applies Bold on top of Body/Regular). The
    // wrapper enforces the textStyle's weight, so we override inline when the
    // IR's fontWeight diverges. Wrapper name suffix encodes its expected
    // weight (Strong=700, Regular=500). Mismatch → inline override.
    const expectedWeight = /Strong$/.test(wrapperName) ? 700 : 500
    if (n.fontWeight !== expectedWeight) wrapperStyles.fontWeight = n.fontWeight
    // figma's HUG width = ceil(advance) creates 0..1 css slack. textAlignHorizontal
    // distributes that slack: LEFT→right, CENTER→half each side, RIGHT→left. Chromium
    // default text-align: start (= LEFT) leaves slack on the right, mismatching figma's
    // CENTER/RIGHT placement by slack/2 or slack css. Mirror figma's choice when not LEFT.
    // JUSTIFIED on single-line falls back to start in CSS, matching figma's behavior.
    if (n.textAlign && n.textAlign !== 'left' && n.textAlign !== 'justified') {
      wrapperStyles.textAlign = n.textAlign
    }
    if (Object.keys(wrapperStyles).length) {
      attrs.push(f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(wrapperStyles))))
    }
    const open = f.createJsxOpeningElement(
      f.createIdentifier(wrapperName), undefined, f.createJsxAttributes(attrs),
    )
    const close = f.createJsxClosingElement(f.createIdentifier(wrapperName))
    // Pass raw string (with `\n`) to typography wrapper; wrapper handles
    // paragraph splitting itself per design-system metadata. Use a template
    // literal so non-ASCII characters (Korean, emoji, etc.) survive the TS
    // printer's default \uXXXX escape behavior.
    const child: ts.JsxChild = n.content.includes('\n')
      ? f.createJsxExpression(undefined, f.createNoSubstitutionTemplateLiteral(n.content))
      : f.createJsxText(n.content)
    return f.createJsxElement(open, [child], close)
  }
  // Fallback: styled span (when textStyleId missing or unknown).
  const styles: Record<string, unknown> = {
    fontSize: resolveValue(n.fontSize, n.tokenIds?.fontSize, ctx.tokenMap),
    lineHeight: resolveValue(n.lineHeight, n.tokenIds?.lineHeight, ctx.tokenMap),
    fontWeight: n.fontWeight,
    color: resolveValue(n.color, n.tokenIds?.color, ctx.tokenMap),
  }
  if (n.textAlign) styles.textAlign = n.textAlign
  if (fixedWidth !== undefined) styles.width = fixedWidth
  if (fillMain) { styles.flex = 1; styles.minWidth = 0 }
  if (fillCross) styles.alignSelf = 'stretch'
  if (isHug) { styles.whiteSpace = 'nowrap'; styles.flexShrink = 0 }
  const open = f.createJsxOpeningElement(
    f.createIdentifier('span'), undefined,
    f.createJsxAttributes([cssAttr(styles, ctx)]),
  )
  const close = f.createJsxClosingElement(f.createIdentifier('span'))
  return f.createJsxElement(open, paragraphChildren(n.content, n.paragraphSpacing, ctx.remBase), close)
}

/** Multi-paragraph block split with `marginBottom: paragraphSpacing` between
 * paragraphs (no spacing on last). Single-paragraph content returns plain text. */
function paragraphChildren(content: string, paragraphSpacing: number, remBase: number): ts.JsxChild[] {
  const paragraphs = content.split('\n')
  if (paragraphs.length <= 1 || paragraphSpacing <= 0) return textChildren(content)
  return paragraphs.map((p, i) => {
    const isLast = i === paragraphs.length - 1
    const styles: Record<string, unknown> = {
      display: 'block',
      whiteSpace: 'inherit',
      ...(isLast ? {} : { marginBottom: px2rem(paragraphSpacing, remBase) }),
    }
    const open = f.createJsxOpeningElement(
      f.createIdentifier('span'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('style'),
          f.createJsxExpression(undefined, valueToExpr(styles))),
      ]),
    )
    return f.createJsxElement(open, [f.createJsxText(p)],
      f.createJsxClosingElement(f.createIdentifier('span')))
  })
}

/**
 * Convert figma `characters` to JSX children. Hard breaks (\n) become explicit
 * `<br/>` so they survive HTML whitespace collapsing regardless of the
 * surrounding white-space CSS — relying on `pre`/`pre-line` is fragile inside
 * `inline-block + width: max-content(...)`.
 */
function textChildren(content: string): ts.JsxChild[] {
  if (!content.includes('\n')) return [f.createJsxText(content)]
  const out: ts.JsxChild[] = []
  const parts = content.split('\n')
  parts.forEach((p, i) => {
    if (p) out.push(f.createJsxText(p))
    if (i < parts.length - 1) {
      out.push(f.createJsxSelfClosingElement(
        f.createIdentifier('br'), undefined, f.createJsxAttributes([]),
      ))
    }
  })
  return out
}

function emitVector(n: IRVector): ts.JsxSelfClosingElement {
  const styles = { width: n.width, height: n.height, background: n.fills[0] ?? '#ccc' }
  return f.createJsxSelfClosingElement(
    f.createIdentifier('div'), undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(styles))),
    ]),
  )
}

/**
 * Emit a figma shape primitive as inline SVG. SVG preserves sub-pixel
 * rasterization (HTML <div> snaps left-edge to integer css px in chromium —
 * see SnapGridProbe). For shapes inside flex layouts that may end up at
 * sub-pixel x positions (odd parity), this is the only way to match figma.
 *
 * Layout: outer <svg> takes flex slot of width×height; <rect>/<ellipse>/etc
 * are at (0,0) within. Rotation handled via SVG transform attribute (figma
 * CCW deg ↔ SVG rotate CW negative).
 */
function emitShape(n: IRShape, ctx: CodegenCtx, parent: ParentCtx = { dir: 'none', mainSizing: 'fixed' }): ts.JsxElement {
  const { width: w, height: h } = n
  // SVG `fill=` is a raw attribute — panda token paths like
  // `content.standard.secondary` would not resolve. Use the raw hex/rgba.
  const fill = n.fill ?? 'none'
  const svgAttrs: Record<string, unknown> = {
    width: w, height: h,
    viewBox: `0 0 ${w} ${h}`,
    style: { display: 'block', flexShrink: 0 },
  }
  // Compute child element attrs based on shape kind
  let inner: ts.JsxChild
  const innerAttrs: Record<string, unknown> = {}
  if (fill !== 'none') innerAttrs.fill = fill
  if (n.strokeColor) {
    innerAttrs.stroke = n.strokeColor
    innerAttrs['strokeWidth'] = n.strokeWeight ?? 1
  }
  // figma rotation: rotate around shape center (figma rotates around top-left
  // of pre-rotation bounding box, but with absoluteBoundingBox already
  // post-rotation in IR, we render at (0,0) and rotate within the box).
  if (n.rotation && Math.abs(n.rotation) > 0.01) {
    innerAttrs.transform = `rotate(${-n.rotation} ${w / 2} ${h / 2})`
  }
  if (n.shape === 'rect') {
    if (n.borderRadius) { innerAttrs.rx = n.borderRadius; innerAttrs.ry = n.borderRadius }
    inner = f.createJsxSelfClosingElement(
      f.createIdentifier('rect'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('width'), f.createJsxExpression(undefined, valueToExpr(w))),
        f.createJsxAttribute(f.createIdentifier('height'), f.createJsxExpression(undefined, valueToExpr(h))),
        ...Object.entries(innerAttrs).map(([k, v]) =>
          f.createJsxAttribute(f.createIdentifier(k), f.createJsxExpression(undefined, valueToExpr(v))),
        ),
      ]),
    )
  } else if (n.shape === 'ellipse') {
    inner = f.createJsxSelfClosingElement(
      f.createIdentifier('ellipse'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('cx'), f.createJsxExpression(undefined, valueToExpr(w / 2))),
        f.createJsxAttribute(f.createIdentifier('cy'), f.createJsxExpression(undefined, valueToExpr(h / 2))),
        f.createJsxAttribute(f.createIdentifier('rx'), f.createJsxExpression(undefined, valueToExpr(w / 2))),
        f.createJsxAttribute(f.createIdentifier('ry'), f.createJsxExpression(undefined, valueToExpr(h / 2))),
        ...Object.entries(innerAttrs).map(([k, v]) =>
          f.createJsxAttribute(f.createIdentifier(k), f.createJsxExpression(undefined, valueToExpr(v))),
        ),
      ]),
    )
  } else {
    // polygon/star/line — fallback to filled rect (will be a coarse approx)
    inner = f.createJsxSelfClosingElement(
      f.createIdentifier('rect'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('width'), f.createJsxExpression(undefined, valueToExpr(w))),
        f.createJsxAttribute(f.createIdentifier('height'), f.createJsxExpression(undefined, valueToExpr(h))),
        ...Object.entries(innerAttrs).map(([k, v]) =>
          f.createJsxAttribute(f.createIdentifier(k), f.createJsxExpression(undefined, valueToExpr(v))),
        ),
      ]),
    )
  }
  const open = f.createJsxOpeningElement(
    f.createIdentifier('svg'), undefined,
    f.createJsxAttributes(Object.entries(svgAttrs).map(([k, v]) =>
      f.createJsxAttribute(f.createIdentifier(k), f.createJsxExpression(undefined, valueToExpr(v))),
    )),
  )
  const close = f.createJsxClosingElement(f.createIdentifier('svg'))
  return f.createJsxElement(open, [inner], close)
}

/** Inline figma vector export (GROUP/VECTOR/BOOLEAN_OPERATION) as an
 * <img src="data:image/svg+xml;base64,...">. SVG keeps vector fidelity at
 * any DPR; the data URL embedding keeps the generated component
 * self-contained (no external asset dir to ship). */
function emitImage(n: IRImage): ts.JsxSelfClosingElement {
  const styles: Record<string, unknown> = { display: 'block', flexShrink: 0 }
  return f.createJsxSelfClosingElement(
    f.createIdentifier('img'), undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(f.createIdentifier('src'),
        f.createStringLiteral(n.dataUrl ?? '')),
      f.createJsxAttribute(f.createIdentifier('width'),
        f.createJsxExpression(undefined, valueToExpr(n.width))),
      f.createJsxAttribute(f.createIdentifier('height'),
        f.createJsxExpression(undefined, valueToExpr(n.height))),
      f.createJsxAttribute(f.createIdentifier('alt'), f.createStringLiteral('')),
      f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(styles))),
    ]),
  )
}

function emitUnknown(n: IRUnknown): ts.JsxSelfClosingElement {
  // Zero-area unknowns (lines, hover-state placeholders) shouldn't perturb flex layout.
  if (n.width === 0 || n.height === 0) {
    return f.createJsxSelfClosingElement(
      f.createIdentifier('div'), undefined,
      f.createJsxAttributes([
        f.createJsxAttribute(f.createIdentifier('style'),
          f.createJsxExpression(undefined, valueToExpr({ display: 'none' }))),
      ]),
    )
  }
  const styles = { width: n.width, height: n.height, background: '#f00' }
  return f.createJsxSelfClosingElement(
    f.createIdentifier('div'), undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(styles))),
    ]),
  )
}

interface CodegenCtx {
  typographyMap: Record<string, string>
  usedTypography: Set<string>
  /** Set when any emitted style is wrapped in `css({...})` — adds the panda
   * import to the generated file. */
  usesCss: boolean
  /** Panda jsx patterns referenced (Flex, Stack, Box). One import per use. */
  usedJsxPatterns: Set<string>
  /** figma variable id → panda token path (e.g. "background.standard.primary"). */
  tokenMap: Record<string, string>
  /** REM base in CSS px. From pixpec.toml `remBase` (default 16). All emitted
   * numeric figma-px values become `(value/remBase)rem`. */
  remBase: number
  /** DS-specific codegen extensions (Icon currentColor, etc.). Each plugin's
   * `emitWrap` runs after the default JSX is built per node. */
  plugins: import('../types.ts').CodegenPlugin[]
}

/** Wrap a JSX child in a `<span style={...}>`. Exposed to plugins via EmitContext. */
function wrapWithStyle(jsx: ts.JsxChild, style: Record<string, unknown>): ts.JsxChild {
  const open = f.createJsxOpeningElement(
    f.createIdentifier('span'), undefined,
    f.createJsxAttributes([
      f.createJsxAttribute(f.createIdentifier('style'),
        f.createJsxExpression(undefined, valueToExpr(style))),
    ]),
  )
  return f.createJsxElement(open, [jsx],
    f.createJsxClosingElement(f.createIdentifier('span')))
}

/** Token-or-px helper: when a figma variable id is bound, emit the panda
 * token path. Otherwise emit `<n>px` (or pass-through string). */
function resolveValue(rawValue: number | string | undefined, tokenId: string | undefined, tokenMap: Record<string, string>): string | number | undefined {
  if (tokenId && tokenMap[tokenId]) return tokenMap[tokenId]
  return rawValue
}

/** figma px → rem string. base from pixpec.toml `remBase` (default 16,
 * matches CSS default html font-size). Emitting rem (not px) lets verify-mode
 * harness scale the html font-size to supersample text layout — chrom's Skia
 * glyph advance is dpr-dependent at small font sizes (14px @ dpr=8 measures
 * ~1.36c smaller than dpr=2), so capturing at dpr=2 with 4× rem-base produces
 * a 56px effective render that downsamples cleanly to figma scale=8 and
 * preserves dpr=2 advance precision. Production at default html font-size:
 * 1rem = 16px, unaffected.
 */
const px2rem = (v: number, base: number): string =>
  `${+(v / base).toFixed(6)}rem`

/**
 * Numeric → 'rem' string for properties that panda interprets as token
 * references when given a bare number (spacing/sizing/radius/border). Other
 * properties (flex, opacity, fontWeight) pass through.
 */
const PX_PROPS = new Set([
  'gap', 'rowGap', 'columnGap',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingInline', 'paddingBlock',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginInline', 'marginBlock',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'top', 'right', 'bottom', 'left', 'inset',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'borderWidth', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontSize', 'lineHeight',
])
function pandaize(styles: Record<string, unknown>, remBase: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(styles)) {
    out[k] = typeof v === 'number' && PX_PROPS.has(k) ? px2rem(v, remBase) : v
  }
  return out
}

/** Build `className={css({...})}` JSX attribute (panda CSS). */
function cssAttr(styles: Record<string, unknown>, ctx: CodegenCtx): ts.JsxAttribute {
  ctx.usesCss = true
  const obj = pandaize(styles, ctx.remBase)
  const call = f.createCallExpression(
    f.createIdentifier('css'), undefined,
    [valueToExpr(obj)],
  )
  return f.createJsxAttribute(
    f.createIdentifier('className'),
    f.createJsxExpression(undefined, call),
  )
}

function lookupTypoByPrefix(liveId: string, map: Record<string, string>): string | undefined {
  // Direct match first.
  if (map[liveId]) return map[liveId]
  for (const key of Object.keys(map)) {
    if (liveId.startsWith(key)) return map[key]
  }
  return undefined
}

interface ParentCtx {
  dir: 'row' | 'column' | 'none'
  /** Parent main-axis sizing — when 'hug', child FILL on main axis collapses to HUG (no flex:1) */
  mainSizing: 'fixed' | 'hug' | 'fill'
}

function emitNode(n: IRNode, ctx: CodegenCtx, parent: ParentCtx = { dir: 'none', mainSizing: 'fixed' }): ts.JsxChild {
  let jsx: ts.JsxChild
  switch (n.kind) {
    case 'component': jsx = emitComponent(n, ctx, parent); break
    case 'frame': jsx = emitFrame(n, ctx, parent); break
    case 'text': jsx = emitText(n, ctx, parent); break
    case 'vector': jsx = emitVector(n); break
    case 'shape': jsx = emitShape(n, ctx, parent); break
    case 'image': jsx = emitImage(n); break
    case 'unknown': jsx = emitUnknown(n); break
  }
  // Plugin emitWrap chain — DS-specific wrapping (e.g. Icon currentColor).
  // Runs BEFORE layout wrap so plugin spans sit between the component and
  // its outer layout span.
  if (ctx.plugins.length) {
    const ectx = { parentDir: parent.dir, f, wrapWithStyle }
    for (const p of ctx.plugins) {
      if (p.emitWrap) jsx = p.emitWrap(n, jsx, ectx)
    }
  }
  // Layout wrap — figma sizing → CSS flex (flex-shrink:0 for FIXED, flex:1 /
  // alignSelf:stretch for FILL). Always the OUTERMOST layer so the parent
  // flex container sees these layout properties directly. Only applies to
  // component instances (frames already emit their own layout in styles).
  // Components don't always honor a `width`/`height` prop (e.g. Divider uses
  // width:100% to fill parent). Emit explicit dim on the wrapper span when
  // the instance is FIXED so the inner component has a concrete bounding box.
  if (n.kind === 'component' && parent.dir !== 'none') {
    const ws: Record<string, unknown> = {}
    if (n.sizingH === 'fixed' && n.sizingV === 'fixed') ws.flexShrink = 0
    else if (n.sizingH === 'fill' && parent.dir === 'row') ws.flex = 1
    else if (n.sizingV === 'fill' && parent.dir === 'column') ws.flex = 1
    else if (n.sizingH === 'fill' && parent.dir === 'column') ws.alignSelf = 'stretch'
    else if (n.sizingV === 'fill' && parent.dir === 'row') ws.alignSelf = 'stretch'
    // Rotation-aware dim: figma autolayout uses the POST-rotation axis-aligned
    // bounding box, but CSS `transform: rotate` doesn't affect layout flow.
    // Compute the rotated bbox so the wrapper reserves the correct space:
    //   rotW = |w cos θ| + |h sin θ|;  rotH = |w sin θ| + |h cos θ|
    // For θ=0 → (w,h), θ=90 → (h,w), θ=45 → ((w+h)/√2, (w+h)/√2), generic θ
    // gets the diagonal-projection dim figma uses.
    const w = n.width, h = n.height
    let rotW = w, rotH = h
    if (typeof n.rotation === 'number' && Math.abs(n.rotation) > 0.01 && typeof w === 'number' && typeof h === 'number') {
      const r = (n.rotation * Math.PI) / 180
      const cs = Math.abs(Math.cos(r)), sn = Math.abs(Math.sin(r))
      rotW = w * cs + h * sn
      rotH = w * sn + h * cs
      // Math.cos(π/2) = 6.12e-17 (not exactly 0) → for 90° rotation, w*cs leaks
      // a 1.0000000000000016 instead of 1. Such sub-femto-pixel values become
      // sub-pixel layout positions in chromium and shift downstream items.
      // Round near-integer values to integer (within 1e-9 = nano-pixel).
      const snap = (v: number) => Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v
      rotW = snap(rotW)
      rotH = snap(rotH)
    }
    if (n.sizingH === 'fixed' && typeof rotW === 'number') ws.width = px2rem(rotW, ctx.remBase)
    if (n.sizingV === 'fixed' && typeof rotH === 'number') ws.height = px2rem(rotH, ctx.remBase)
    if (Object.keys(ws).length) {
      // inline-block (not inline-flex) so an inner element with its own
      // explicit width/height (e.g. a rotation wrap) isn't shrunk by a
      // would-be flex container's main-axis sizing.
      jsx = wrapWithStyle(jsx, { ...ws, display: 'inline-block' })
    }
  }
  // figma layoutPositioning=ABSOLUTE → child overlays parent at (x,y).
  // Wrap with position:absolute + left/top so the child sits outside flex
  // flow but still in DOM. Parent gets position:relative emitted in emitFrame.
  if (n.absolute) {
    jsx = wrapWithStyle(jsx, {
      position: 'absolute',
      left: typeof n.absX === 'number' ? px2rem(n.absX, ctx.remBase) : '0rem',
      top: typeof n.absY === 'number' ? px2rem(n.absY, ctx.remBase) : '0rem',
    })
  }
  return jsx
}

function collectComponents(node: IRNode, set: Set<string>): void {
  if (node.kind === 'component') set.add(node.componentName)
  if (node.kind === 'frame') for (const c of node.children) collectComponents(c, set)
}

/** Generate self-contained tsx file source. */
export function generate(
  root: IRNode,
  components: Component<unknown>[],
  typographyMap: Record<string, string> = {},
  tokenMap: Record<string, string> = {},
  plugins: import('../types.ts').CodegenPlugin[] = [],
  remBase: number = 16,
): string {
  hydrate(root, components)
  const usedComponents = new Set<string>()
  collectComponents(root, usedComponents)
  const ctx: CodegenCtx = {
    typographyMap, usedTypography: new Set(),
    usesCss: false, usedJsxPatterns: new Set(),
    tokenMap,
    remBase,
    plugins,
  }

  const componentImports = [...usedComponents].sort().map((n) =>
    f.createImportDeclaration(undefined,
      f.createImportClause(false, undefined,
        f.createNamedImports([
          f.createImportSpecifier(false, f.createIdentifier('impl'), f.createIdentifier(n)),
        ])),
      f.createStringLiteral(`../${n}/impl.tsx`),
    ),
  )
  // Pre-emit body so usedTypography is populated.
  const body = emitNode(root, ctx) as ts.Expression
  const typographyImports = ctx.usedTypography.size > 0
    ? [f.createImportDeclaration(undefined,
        f.createImportClause(false, undefined,
          f.createNamedImports([...ctx.usedTypography].sort().map((n) =>
            f.createImportSpecifier(false, undefined, f.createIdentifier(n))))),
        f.createStringLiteral('../typography/index.tsx'))]
    : []
  const cssImport = ctx.usesCss
    ? [f.createImportDeclaration(undefined,
        f.createImportClause(false, undefined,
          f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier('css'))])),
        f.createStringLiteral('../../../styled-system/css'))]
    : []
  const jsxPatternImport = ctx.usedJsxPatterns.size > 0
    ? [f.createImportDeclaration(undefined,
        f.createImportClause(false, undefined,
          f.createNamedImports([...ctx.usedJsxPatterns].sort().map((n) =>
            f.createImportSpecifier(false, undefined, f.createIdentifier(n))))),
        f.createStringLiteral('../../../styled-system/jsx'))]
    : []
  const importStatements = [...componentImports, ...typographyImports, ...cssImport, ...jsxPatternImport]
  const fcImport = f.createImportDeclaration(undefined,
    f.createImportClause(true, undefined,
      f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier('FC'))])),
    f.createStringLiteral('react'),
  )
  const generatedFn = f.createVariableStatement(
    [f.createModifier(ts.SyntaxKind.ExportKeyword)],
    f.createVariableDeclarationList([
      f.createVariableDeclaration(
        f.createIdentifier('Generated'),
        undefined,
        f.createTypeReferenceNode('FC'),
        f.createArrowFunction(undefined, undefined, [], undefined,
          f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
          f.createParenthesizedExpression(body),
        ),
      ),
    ], ts.NodeFlags.Const),
  )
  const implExport = f.createVariableStatement(
    [f.createModifier(ts.SyntaxKind.ExportKeyword)],
    f.createVariableDeclarationList([
      f.createVariableDeclaration(
        f.createIdentifier('impl'),
        undefined,
        f.createTypeReferenceNode('FC'),
        f.createArrowFunction(undefined, undefined, [], undefined,
          f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
          f.createJsxSelfClosingElement(f.createIdentifier('Generated'), undefined, f.createJsxAttributes([])),
        ),
      ),
    ], ts.NodeFlags.Const),
  )
  const sourceFile = f.createSourceFile(
    [fcImport, ...importStatements, generatedFn, implExport],
    f.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  )
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
  // TS printer escapes non-ASCII as \uXXXX. Restore so Korean/emoji content
  // reads naturally in the generated source. Safe because the codegen never
  // intentionally emits a `\u` escape sequence — all non-ASCII originates
  // from figma `characters` which we want as raw glyphs.
  return printer.printFile(sourceFile).replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_, hex) => String.fromCharCode(parseInt(hex, 16)),
  )
}
