/**
 * Design-AST value → Slint expression text. Token paths become
 * `Tokens.<kebab-id>` references; literals are formatted with explicit
 * units. Centralised so token-flattening rules stay consistent across
 * every per-node lowering module.
 */

import type { Size, Color } from '../../compiler/design-ast.ts'
import type { SExpr } from './ir.ts'

/** Dot-path → kebab identifier. Mirrors `build-tokens.ts` flattening rule
 *  so the emitted reference resolves against the generated tokens.slint. */
export function tokenIdent(dotPath: string): string {
  return dotPath.replace(/\./g, '-')
}

export function sizeExpr(s: Size | undefined): SExpr | undefined {
  if (!s) return undefined
  if ('tokenPath' in s) return `Tokens.${tokenIdent(s.tokenPath)}`
  return `${s.value}px`
}

export function colorExpr(c: Color | undefined): SExpr | undefined {
  if (!c) return undefined
  if ('tokenPath' in c) {
    const ref = `Tokens.${tokenIdent(c.tokenPath)}`
    return c.opacity !== undefined ? `${ref}.with-alpha(${c.opacity})` : ref
  }
  // Literal — `color` is a CSS color string (#hex / rgba(...)) which Slint
  // parses natively. Apply optional layer opacity via .with-alpha.
  if (c.opacity !== undefined) return `${c.color}.with-alpha(${c.opacity})`
  return c.color
}
