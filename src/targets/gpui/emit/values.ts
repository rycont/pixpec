import type { Color, ExpressionValue, Size, Value } from '../../../compiler/design-ast.ts'
import type { GpuiEmitContext } from './context.ts'
import { hex, num } from './rust.ts'

export function sizeExpr(size: Size | ExpressionValue, ctx: GpuiEmitContext): string {
  return scaledPx(sizeValue(size, ctx), ctx)
}

export function sizeValue(size: Size | ExpressionValue, ctx: GpuiEmitContext): number {
  if (isExpressionValue(size)) {
    throw new Error(`gpui target does not support prop expression sizes: ${size.name}`)
  }
  if ('tokenPath' in size) return ctx.tokenValueMap[size.tokenPath] ?? 0
  return size.value
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

export function literalValue<T>(value: Value<T>): T {
  return value.kind === 'literal' && value.source === 'raw' ? value.value : (undefined as T)
}

export function colorExpr(color: Color | Value<Color>, ctx: GpuiEmitContext): string {
  if ('kind' in color) {
    if (color.kind === 'expression') return 'rgb(0x000000)'
    if (color.source === 'token') return colorExprFromCss(ctx.tokenColorMap[color.path]) ?? 'rgb(0x000000)'
    return colorExpr(color.value, ctx)
  }
  if ('tokenPath' in color) {
    const resolved = colorExprFromCss(ctx.tokenColorMap[color.tokenPath])
    return resolved ?? 'rgb(0x000000)'
  }
  return colorExprFromCss(color.color) ?? 'rgb(0x000000)'
}

function colorExprFromCss(value: string | undefined): string | undefined {
  if (!value) return undefined
  const rgbaMatch = /^rgba\((\d+),(\d+),(\d+),([0-9.]+)\)$/.exec(value)
  if (rgbaMatch) {
    const [, r, g, b, a] = rgbaMatch
    const alpha = Math.round(Number(a) * 255)
    return `rgba(0x${hex(Number(r))}${hex(Number(g))}${hex(Number(b))}${hex(alpha)})`
  }
  const hexMatch = /^#([0-9a-fA-F]{6})$/.exec(value)
  if (hexMatch) return `rgb(0x${hexMatch[1]})`
  return undefined
}

function isExpressionValue(value: unknown): value is ExpressionValue {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'expression'
}
