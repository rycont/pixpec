import type { DText, LengthValue, TextStyle } from '../../../compiler/design-ast.ts'
import { Sizing, TextAlign, TextAutoResize } from '../../../compiler/design-ast.ts'
import { div } from './chain.ts'
import type { GpuiEmitContext } from './context.ts'
import { addNodeLayout } from './layout.ts'
import { num, str } from './rust.ts'
import { colorExpr, isAxisLength, lengthExpr, lengthNumber, literalString, rawPx } from './values.ts'

export function emitText(n: DText, ctx: GpuiEmitContext, indent: number): string {
  const style = resolveTextStyle(n.textStyle)
  const content = literalString(n.content) ?? ''
  const shift = textShift(style.fontFamily, style.fontSize, ctx)
  const chain = div(indent)
    .child(str(content))
    .method('text_color', colorExpr(n.color, ctx))

  if (n.width === Sizing.Fill) {
    chain.method('flex_grow')
    chain.method('flex_shrink_0')
  } else if (isAxisLength(n.width)) chain.method('w', lengthExpr(n.width, ctx))

  if (style.fontSize) chain.method('text_size', lengthExpr(style.fontSize, ctx))
  if (style.lineHeight) chain.method('line_height', lengthExpr(style.lineHeight, ctx))

  addNodeLayout(chain, n, ctx, shift)

  if (n.autoResize === TextAutoResize.Hug && !content.includes('\n')) {
    chain.method('whitespace_nowrap')
  }
  if (style.fontFamily) chain.method('font_family', str(style.fontFamily))
  if (style.fontWeight) chain.method('font_weight', `FontWeight(${num(style.fontWeight)})`)
  if (n.textAlign === TextAlign.Center) chain.method('text_center')
  else if (n.textAlign === TextAlign.Right) chain.method('text_right')
  if (!n.absolute && (shift.x || shift.y)) {
    chain.method('relative')
    if (shift.x) chain.method('left', rawPx(shift.x))
    if (shift.y) chain.method('top', rawPx(shift.y))
  }

  return chain.toString()
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
