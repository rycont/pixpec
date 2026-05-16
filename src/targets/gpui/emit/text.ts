import type { Color, DText, DTextRun, LengthValue, TextStyle } from '../../../compiler/design-ast.ts'
import { Sizing, TextAlign, TextAutoResize } from '../../../compiler/design-ast.ts'
import { div, GpuiChain } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { num, str, pad } from './rust.ts'
import { colorExpr, isAxisLength, lengthExpr, lengthNumber, literalString, rawPx } from './values.ts'

export function emitText(n: DText, ctx: GpuiEmitContext, indent: number): string {
  const style = resolveTextStyle(n.textStyle)
  const content = literalString(n.content) ?? ''
  const shift = textShift(style.fontFamily, style.fontSize, ctx)
  const paragraphSpacing = style.paragraphSpacing ? lengthNumber(style.paragraphSpacing, ctx) : 0

  // Figma applies `paragraphSpacing` between paragraphs of a single text node
  // (delimited by `\n`). GPUI text has no equivalent — line_height alone
  // would stack lines flush. To match figma's vertical advance, split into
  // one child per paragraph and gap them with paragraphSpacing.
  const styled = hasStyledRuns(n)
  const paragraphs = paragraphSpacing > 0 && content.includes('\n') ? content.split('\n') : null

  if (paragraphs && paragraphs.length > 1) {
    const wrapper = div(indent).method('flex').method('flex_col').method('gap', `px(${rustFloat(paragraphSpacing)})`)
    if (n.width === Sizing.Fill) {
      wrapper.method('flex_grow')
      wrapper.method('flex_shrink_0')
    } else if (isAxisLength(n.width)) wrapper.method('w', lengthExpr(n.width, ctx))
    addNodeLayout(wrapper, n, ctx, shift)
    if (!n.absolute && (shift.x || shift.y)) {
      wrapper.method('relative')
      if (shift.x) wrapper.method('left', rawPx(shift.x))
      if (shift.y) wrapper.method('top', rawPx(shift.y))
    }

    let offset = 0
    for (const para of paragraphs) {
      const start = offset
      const end = offset + Buffer.byteLength(para, 'utf8')
      const paraRuns = styled ? sliceRuns(n.runs!, content, start, end) : undefined
      const paraChain = buildLineChain(para, n, style, ctx, indent + 2, paraRuns)
      wrapper.child(paraChain.toString())
      // +1 for the '\n' between paragraphs in the original content
      offset = end + 1
    }
    return wrapper.toString()
  }

  const chain = buildLineChain(content, n, style, ctx, indent, styled ? n.runs : undefined)

  if (n.width === Sizing.Fill) {
    chain.method('flex_grow')
    chain.method('flex_shrink_0')
  } else if (isAxisLength(n.width)) chain.method('w', lengthExpr(n.width, ctx))

  addNodeLayout(chain, n, ctx, shift)

  if (n.autoResize === TextAutoResize.Hug && !content.includes('\n')) {
    chain.method('whitespace_nowrap')
  }
  if (!n.absolute && (shift.x || shift.y)) {
    chain.method('relative')
    if (shift.x) chain.method('left', rawPx(shift.x))
    if (shift.y) chain.method('top', rawPx(shift.y))
  }

  return chain.toString()
}

/** Build a `div(...).text_color(...)...child(text-or-StyledText)` chain for
 *  a single text line. When `runs` carry distinct per-segment colors we emit
 *  `gpui::StyledText::new(...).with_highlights([(byte_range, HighlightStyle{
 *  color, ..Default }), ...])` so cosmic-text paints each span in figma's
 *  source color while the wrapper div's text_color stays the default. */
function buildLineChain(
  content: string,
  n: DText,
  style: TextStyle,
  ctx: GpuiEmitContext,
  indent: number,
  runs: DTextRun[] | undefined,
): GpuiChain {
  const chain = div(indent)
  if (runs && hasDistinctColors(runs, n.color)) {
    chain.child(buildStyledText(content, runs, n.color, ctx, indent + 1))
  } else {
    chain.child(str(content))
  }
  chain.method('text_color', colorExpr(n.color, ctx))
  if (style.fontSize) chain.method('text_size', lengthExpr(style.fontSize, ctx))
  if (style.lineHeight) chain.method('line_height', lengthExpr(style.lineHeight, ctx))
  if (style.fontFamily) chain.method('font_family', str(style.fontFamily))
  if (style.fontWeight) chain.method('font_weight', `FontWeight(${num(style.fontWeight)})`)
  if (n.textAlign === TextAlign.Center) chain.method('text_center')
  else if (n.textAlign === TextAlign.Right) chain.method('text_right')
  return chain
}

function buildStyledText(
  content: string,
  runs: DTextRun[],
  defaultColor: Color,
  ctx: GpuiEmitContext,
  indent: number,
): string {
  const lines: string[] = []
  lines.push(`${pad(indent)}gpui::StyledText::new(${str(content)}).with_highlights(vec![`)
  let offset = 0
  const defaultExpr = colorExpr(defaultColor, ctx)
  for (const run of runs) {
    const len = Buffer.byteLength(run.text, 'utf8')
    if (run.color !== undefined && !sameColor(run.color, defaultColor)) {
      const start = offset
      const end = offset + len
      lines.push(`${pad(indent + 1)}(${start}..${end}, gpui::HighlightStyle { color: Some(${colorExpr(run.color, ctx)}.into()), ..Default::default() }),`)
      void defaultExpr
    }
    offset += len
  }
  lines.push(`${pad(indent)}])`)
  return lines.join('\n')
}

function sliceRuns(runs: DTextRun[], fullContent: string, byteStart: number, byteEnd: number): DTextRun[] {
  const out: DTextRun[] = []
  let offset = 0
  for (const run of runs) {
    const runLen = Buffer.byteLength(run.text, 'utf8')
    const runStart = offset
    const runEnd = offset + runLen
    offset = runEnd
    if (runEnd <= byteStart || runStart >= byteEnd) continue
    // Compute the byte range to keep, then map back to characters to slice run.text.
    const cutStart = Math.max(0, byteStart - runStart)
    const cutEnd = Math.min(runLen, byteEnd - runStart)
    if (cutEnd <= cutStart) continue
    // Slice run.text by byte offsets. Strings in JS are UTF-16 — convert via Buffer.
    const buf = Buffer.from(run.text, 'utf8')
    const piece = buf.slice(cutStart, cutEnd).toString('utf8')
    if (piece.length === 0) continue
    out.push({ ...run, text: piece })
  }
  void fullContent
  return out
}

function hasStyledRuns(n: DText): boolean {
  if (!n.runs || n.runs.length === 0) return false
  return hasDistinctColors(n.runs, n.color)
}

function hasDistinctColors(runs: DTextRun[], defaultColor: Color): boolean {
  return runs.some((r) => r.color !== undefined && !sameColor(r.color, defaultColor))
}

function sameColor(a: Color, b: Color): boolean {
  if (a === b) return true
  // Compare via their literal value when both are literals, else string-compare for now.
  if (typeof a === 'object' && typeof b === 'object' && a && b && 'kind' in a && 'kind' in b) {
    if (a.kind === 'literal' && b.kind === 'literal') {
      const av = (a as { value: unknown }).value
      const bv = (b as { value: unknown }).value
      return JSON.stringify(av) === JSON.stringify(bv)
    }
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

function rustFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${+value.toFixed(6)}`
}

function resolveTextStyle(value: DText['textStyle']): TextStyle {
  if (typeof value === 'string') return {}
  if (!value) return {}
  if ('kind' in value) {
    if (value.kind === 'expression') return {}
    return (value as { kind: 'literal'; value: TextStyle }).value ?? {}
  }
  const { base: _base, ...rest } = value as { base: string } & Partial<TextStyle>
  return rest as TextStyle
}

function textShift(
  family: string | undefined,
  fontSize: LengthValue | undefined,
  ctx: GpuiEmitContext,
): { x?: number; y?: number } {
  if (!family || !fontSize) return {}
  const font = ctx.fonts?.fonts?.find((f) => f.family === family)
  const baseSize = lengthNumber(fontSize, ctx)
  const renderedSize = baseSize * ctx.renderScale
  if (!font) return defaultTextShift(family, baseSize, ctx.renderScale)
  return {
    x: lookupShift(font.xShift, renderedSize),
    y: lookupShift(font.yShift, renderedSize) ?? defaultTextShift(family, baseSize, ctx.renderScale).y,
  }
}

function defaultTextShift(_family: string, _baseSize: number, _renderScale: number): { x?: number; y?: number } {
  // codegen carries no per-font knowledge. Baseline calibration is data that
  // belongs in the project's pixpec-fonts.json `yShift` table — emitters look
  // it up via `lookupShift` above.
  return {}
}

function lookupShift(table: Record<string, number> | undefined, renderedSize: number): number | undefined {
  if (!table) return undefined
  const exact = table[String(renderedSize)]
  if (typeof exact === 'number') return exact
  const rounded = table[String(Math.round(renderedSize))]
  if (typeof rounded === 'number') return rounded
  return undefined
}
