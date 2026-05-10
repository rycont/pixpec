/**
 * IR validator — runs between walker and codegen. Walks the IR tree and
 * collects diagnostics from each registered rule. Throws an aggregated
 * error before codegen if any rule fails.
 *
 * Why a separate pass: rules that catch design-system invariants (font
 * registry, token coverage, sizing inconsistencies) belong outside emit.
 * Emitting and asserting in the same function couples errors to the JSX
 * shape and obscures which rule fired. Aggregating means the user sees
 * every problem from a single run, not one error → fix → next error.
 */
import type { IRNode } from './ir.ts'

export interface ValidationContext {
  /** Font families with @font-face declarations available at render time
   * (loaded by cli.ts from src/global.css etc). When empty, the font rule
   * is skipped (project hasn't supplied a registry). */
  registeredFonts: Set<string>
}

export interface ValidationIssue {
  /** Originating IR node id — used by the user to locate the figma node. */
  figmaId: string
  /** Short message describing the violation. */
  message: string
}

type Rule = (n: IRNode, ctx: ValidationContext, out: ValidationIssue[]) => void

/** Walk every node in the IR tree (depth-first), invoking each rule per node. */
function walk(n: IRNode, rules: Rule[], ctx: ValidationContext, out: ValidationIssue[]) {
  for (const r of rules) r(n, ctx, out)
  if (n.kind === 'frame') for (const c of n.children) walk(c, rules, ctx, out)
}

/** Rule: every TEXT node's fontFamily must have a meta.toml under src/fonts/.
 * Exact-match only — no aliases. If figma reports "Wanted Sans" and only
 * "Wanted Sans Variable" is registered, the project must add a separate
 * font directory (or change the figma source). */
const fontRegistered: Rule = (n, ctx, out) => {
  if (n.kind !== 'text' || ctx.registeredFonts.size === 0) return
  const families = new Set<string>()
  if (n.fontFamily) families.add(n.fontFamily)
  for (const r of n.runs ?? []) if (r.fontFamily) families.add(r.fontFamily)
  for (const family of families) {
    if (!ctx.registeredFonts.has(family)) {
      out.push({
        figmaId: n.figmaId,
        message: `text ${JSON.stringify(n.content.slice(0, 24))} references unregistered font ${JSON.stringify(family)}`,
      })
    }
  }
}

const RULES: Rule[] = [fontRegistered]

/**
 * Validate `root` and throw an aggregated error if any issue is found.
 * `ctx.registeredFonts` empty → font rule no-ops; safe to call from
 * projects that haven't wired the registry yet.
 */
export function validateIR(root: IRNode, ctx: ValidationContext): void {
  const issues: ValidationIssue[] = []
  walk(root, RULES, ctx, issues)
  if (issues.length === 0) return
  const lines = issues.map((i) => `  - ${i.figmaId}: ${i.message}`).join('\n')
  const fontList = [...ctx.registeredFonts].map((f) => JSON.stringify(f)).join(', ') || '<none>'
  throw new Error(
    `IR validation failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${lines}\n\n` +
    `Registered fonts: ${fontList}\n` +
    `Add @font-face declarations (or alias to an existing file) before chromium falls back to system-ui (which raster-diverges from figma).`,
  )
}
