import type {
  Color,
  ColorLiteral,
  ExpressionValue,
  LengthValue,
  Paint,
} from '../../../compiler/design-ast.ts'
import { Sizing } from '../../../compiler/design-ast.ts'
import type { GpuiEmitContext } from './context.ts'
import { hex, num } from './rust.ts'

export function isAxisLength(value: unknown): value is LengthValue {
  if (typeof value === 'string') {
    return value !== Sizing.Hug && value !== Sizing.Fill && value !== Sizing.Fixed
  }
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'literal' || kind === 'expression'
}

export function lengthExpr(value: LengthValue, ctx: GpuiEmitContext): string {
  return scaledPx(lengthNumber(value, ctx), ctx)
}

export function lengthNumber(value: LengthValue, ctx: GpuiEmitContext): number {
  if (typeof value === 'string') return ctx.tokenValueMap[value] ?? 0
  if (value.kind === 'expression') {
    throw new Error(`gpui target does not support prop expression lengths: ${value.name}`)
  }
  if (value.value.unit === '%') {
    // Scale-anchor children carry inset/sizes as parent-relative percentages.
    // GPUI's chain API expects absolute px, and the call site doesn't have
    // the parent dimension here — surface the gap explicitly rather than
    // silently emitting the bare percent value as if it were px.
    throw new Error(
      `gpui target does not yet support '%' lengths (Scale-anchor child); value=${value.value.value}%`,
    )
  }
  return value.value.value
}

export function scaledPx(value: number | ExpressionValue, ctx: GpuiEmitContext): string {
  if (typeof value !== 'number') {
    throw new Error(`gpui target does not support prop expression numbers: ${value.name}`)
  }
  return rawPx(value * ctx.renderScale)
}

export function scaledPxWithOffset(
  value: number,
  ctx: GpuiEmitContext,
  renderedOffset: number | undefined,
): string {
  return rawPx(value * ctx.renderScale + (renderedOffset ?? 0))
}

export function rawPx(value: number): string {
  return `px(${num(value)})`
}

export function literalString(value: { kind: string; value?: unknown } | string | undefined): string | undefined {
  if (typeof value === 'string') return undefined
  if (!value) return undefined
  if (value.kind === 'literal' && typeof value.value === 'string') return value.value
  return undefined
}

export function colorLiteralFromValue(
  value: Color | Paint,
  ctx: GpuiEmitContext,
): ColorLiteral | undefined {
  if (typeof value === 'string') {
    // TokenRef — look up in token color map (css string)
    return parseCssColor(ctx.tokenColorMap[value])
  }
  if (value.kind === 'expression') return undefined
  // literal
  const v = value.value
  if (!v) return undefined
  if ('r' in v && 'g' in v && 'b' in v) return v as ColorLiteral
  // gradient — pick first stop color
  if ('kind' in v && v.kind === 'linearGradient' && v.stops.length) {
    return colorLiteralFromValue(v.stops[0]!.color, ctx)
  }
  return undefined
}

export function colorExpr(value: Color | Paint, ctx: GpuiEmitContext): string {
  const lit = colorLiteralFromValue(value, ctx)
  return colorExprFromLiteral(lit) ?? 'rgb(0x000000)'
}

function colorExprFromLiteral(c: ColorLiteral | undefined): string | undefined {
  if (!c) return undefined
  const r = clamp255(c.r)
  const g = clamp255(c.g)
  const b = clamp255(c.b)
  const a = c.a === undefined ? 255 : clamp255(Math.round(c.a * 255))
  if (a === 255) return `rgb(0x${hex(r)}${hex(g)}${hex(b)})`
  return `rgba(0x${hex(r)}${hex(g)}${hex(b)}${hex(a)})`
}

function parseCssColor(value: string | undefined): ColorLiteral | undefined {
  if (!value) return undefined
  const rgbaMatch = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/.exec(value)
  if (rgbaMatch) {
    return {
      r: Number(rgbaMatch[1]),
      g: Number(rgbaMatch[2]),
      b: Number(rgbaMatch[3]),
      a: rgbaMatch[4] !== undefined ? Number(rgbaMatch[4]) : undefined,
    }
  }
  const hexMatch = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value)
  if (hexMatch) {
    const hx = hexMatch[1]!
    return {
      r: parseInt(hx.slice(0, 2), 16),
      g: parseInt(hx.slice(2, 4), 16),
      b: parseInt(hx.slice(4, 6), 16),
      a: hexMatch[2] ? parseInt(hexMatch[2], 16) / 255 : undefined,
    }
  }
  return undefined
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}
