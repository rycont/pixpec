import type { DText } from '../../../compiler/design-ast.ts'
import { Positioning, TextAlign, TextAutoResize } from '../../../compiler/design-ast.ts'
import { div } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { num, str } from './rust.ts'
import { colorExpr, literalValue, rawPx, scaledPx, sizeExpr, sizeValue } from './values.ts'

export function emitText(n: DText, ctx: GpuiEmitContext, indent: number): string {
  const shift = textShift(n, ctx)
  const content = literalValue(n.content) ?? ''
  const chain = div(indent)
    .child(str(content))
    .method('w', scaledPx(n.width, ctx))
    .method('text_color', colorExpr(n.color, ctx))
    .method('text_size', sizeExpr(n.fontSize, ctx))
    .method('line_height', sizeExpr(n.lineHeight, ctx))
  addNodeLayout(chain, n, ctx, shift)

  if (n.autoResize === TextAutoResize.Hug && !content.includes('\n')) {
    chain.method('whitespace_nowrap')
  }
  if (n.fontFamily) chain.method('font_family', str(n.fontFamily))
  if (n.fontWeight) chain.method('font_weight', `FontWeight(${num(n.fontWeight)})`)
  if (n.textAlign === TextAlign.Center) chain.method('text_center')
  else if (n.textAlign === TextAlign.Right) chain.method('text_right')
  if (n.positioning !== Positioning.Absolute && (shift.x || shift.y)) {
    chain.method('relative')
    if (shift.x) chain.method('left', rawPx(shift.x))
    if (shift.y) chain.method('top', rawPx(shift.y))
  }

  return chain.toString()
}

function textShift(n: DText, ctx: GpuiEmitContext): { x?: number; y?: number } {
  if (!n.fontFamily) return {}
  const font = ctx.fonts?.fonts?.find((f) => f.family === n.fontFamily)
  const baseSize = sizeValue(n.fontSize, ctx)
  const renderedSize = baseSize * ctx.renderScale
  if (!font) return defaultTextShift(n.fontFamily, baseSize, ctx.renderScale)
  return {
    x: lookupShift(font.xShift, renderedSize),
    y: lookupShift(font.yShift, renderedSize) ?? defaultTextShift(n.fontFamily, baseSize, ctx.renderScale).y,
  }
}

function defaultTextShift(family: string, baseSize: number, renderScale: number): { x?: number; y?: number } {
  if (family === 'Wanted Sans Variable' && Math.abs(baseSize - 48) < 0.01) {
    return { y: -1 * renderScale }
  }
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
