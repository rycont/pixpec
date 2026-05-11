/**
 * Slint design-system token builder.
 *
 *   panda-tokens.ts  →  tokens.slint  (single `export global Tokens` singleton)
 *
 * Reads the resolved nested-object form produced by danah's
 * `build-panda-tokens.ts` (alias chains already followed, mode-split,
 * categorised). The "panda" name on that artefact is incidental — the
 * shape is generic and we treat it as a neutral resolved-tokens schema:
 *
 *   colors:   { <path>: { value: { base: <css>, _dark?: <css> } | <css> } }
 *   radii:    { <path>: { value: <Nrem> } }
 *   spacing:  { <path>: { value: <Nrem> } }
 *   sizes:    { <path>: { value: <Nrem> } }
 *
 * `<path>` is freely nested. Each LEAF (object containing `value`) becomes
 * one Slint property. Identifier = inner path joined with `-` (top-level
 * category name like "colors" / "radii" is NOT included). Slint allows
 * `[a-zA-Z_][a-zA-Z0-9_-]*` so numeric segments inside the path work fine.
 *
 * Light mode only for now (`value.base` for colors, ignore `_dark`). Dark-
 * mode toggling is a future pass — Slint's natural fit there is a runtime-
 * settable property on this same global, but expressing it requires deciding
 * the consumer's theming contract.
 */

export interface PandaTokensInput {
  colors?: Record<string, unknown>
  radii?: Record<string, unknown>
  spacing?: Record<string, unknown>
  sizes?: Record<string, unknown>
  /** Compound text styles — leaves shaped
   *    `{ value: { fontFamily, fontSize, fontWeight, lineHeight } }`.
   *  fontFamily values may carry panda alias `{fonts.<key>}` references —
   *  resolved via `fonts` below. */
  textStyles?: Record<string, unknown>
  /** Panda fonts category — `{ sans: { value: '"Wanted Sans Variable", ...' } }`.
   *  Used to expand alias refs in textStyles' fontFamily field. */
  fonts?: Record<string, unknown>
}

/** Raw figma-tokens.json shape (subset). Used to recover length-typed
 *  variables that panda-tokens.ts loses by bundling them into textStyles
 *  — `Size/*`, `Line Height/*`, `Paragraph Spacing/*` are figma FLOAT vars
 *  the compiler emits as `tokenPath: "size.body"` etc., and that the AST
 *  references on every text node. Without a flat property of that name on
 *  the Tokens global, the generated component fails to compile.
 *
 *  We treat these vars as direct numeric values — no alias resolution.
 *  Their figma names don't carry alias chains in danah's design system, and
 *  the compiler's own `tokenValueMap` in generate.ts uses the same shortcut.
 *  If a future DS introduces aliasing on length vars, the failure mode is
 *  visible: `Tokens.<id>` will reference a missing identifier and the slint
 *  compiler will reject the generated source — at which point this loader
 *  grows alias support, not silent fallback. */
export interface FigmaTokensInput {
  variables?: Array<{
    id: string
    key?: string
    name: string
    resolvedType: string
    valuesByMode?: Record<string, unknown>
  }>
}

export interface BuildTokensOptions {
  /** rem → px factor. Panda default and pixpec convention is 16. */
  remBase?: number
}

interface Leaf {
  /** Kebab identifier (no top-level category prefix). */
  id: string
  /** Slint-formatted value literal (e.g. "#aabbcc", "rgba(...)", "8px"). */
  value: string
}

interface TextStyleLeaf {
  id: string
  fontFamily: string
  fontSize: string
  fontWeight: number
  lineHeight: string
}

const SLINT_IDENT = /^[a-zA-Z_][a-zA-Z0-9_-]*$/

function pathToId(parts: ReadonlyArray<string>): string {
  const id = parts.join('-')
  if (!SLINT_IDENT.test(id)) {
    throw new Error(`buildSlintTokens: invalid Slint identifier "${id}" (path: ${parts.join('.')})`)
  }
  return id
}

/** rem string → Slint length literal. */
function remToPx(rem: string, remBase: number): string {
  const m = rem.match(/^(-?\d+(?:\.\d+)?)rem$/)
  if (!m) {
    // Already px or unitless — pass through as length if it looks like it.
    if (/^-?\d+(?:\.\d+)?px$/.test(rem)) return rem
    throw new Error(`remToPx: unrecognized length value "${rem}"`)
  }
  const px = +(parseFloat(m[1]) * remBase).toFixed(6)
  return `${px}px`
}

/** Color value → Slint color literal. Accepts CSS hex (#rrggbb / #rrggbbaa)
 *  and rgba(r, g, b, a) strings; both forms parse natively in Slint. */
function colorValue(css: string): string {
  const s = css.trim()
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return s
  // rgba(r, g, b, a) with float alpha — Slint accepts this directly.
  if (/^rgba?\s*\(/.test(s)) return s.replace(/\s+/g, ' ')
  throw new Error(`colorValue: unrecognized color "${css}"`)
}

/** Walk a panda-shape category, collecting (path, value) leaves. The walker
 *  recognises a leaf by the presence of a `value` key on the current node. */
function walkCategory(
  cat: unknown,
  path: ReadonlyArray<string>,
  acc: Leaf[],
  toLiteral: (v: unknown) => string | undefined,
): void {
  if (!cat || typeof cat !== 'object') return
  // Leaf?
  const o = cat as Record<string, unknown>
  if ('value' in o) {
    const lit = toLiteral(o.value)
    if (lit !== undefined) acc.push({ id: pathToId(path), value: lit })
    return
  }
  for (const [k, v] of Object.entries(o)) {
    walkCategory(v, [...path, k], acc, toLiteral)
  }
}

export function buildSlintTokens(
  input: PandaTokensInput,
  opts: BuildTokensOptions = {},
  figma?: FigmaTokensInput,
): string {
  const remBase = opts.remBase ?? 16

  const colorLeaf = (raw: unknown): string | undefined => {
    if (typeof raw === 'string') return colorValue(raw)
    if (raw && typeof raw === 'object' && 'base' in (raw as Record<string, unknown>)) {
      const base = (raw as { base: unknown }).base
      if (typeof base === 'string') return colorValue(base)
    }
    return undefined
  }
  const lengthLeaf = (raw: unknown): string | undefined => {
    if (typeof raw === 'string') return remToPx(raw, remBase)
    return undefined
  }

  const colors: Leaf[] = []
  const lengths: Leaf[] = []
  walkCategory(input.colors, [], colors, colorLeaf)
  walkCategory(input.radii, [], lengths, lengthLeaf)
  walkCategory(input.spacing, [], lengths, lengthLeaf)
  walkCategory(input.sizes, [], lengths, lengthLeaf)

  // ───── figma FLOAT vars not preserved by panda (Size/*, Line Height/*, ...)
  // Mirrors generate.ts's name → dot-path conversion so the resulting
  // identifier matches what compile() emits as tokenPath on text nodes.
  if (figma?.variables) {
    for (const v of figma.variables) {
      if (v.resolvedType !== 'FLOAT') continue
      if (!v.valuesByMode) continue
      const num = Object.values(v.valuesByMode).find((x): x is number => typeof x === 'number')
      if (typeof num !== 'number') continue
      const cleanName = v.name.replace(/[\x00-\x1f]/g, '')
      const dotPath = cleanName.split('/')
        .map((s) => s.replace(/\s+/g, '').replace(/^./, (c) => c.toLowerCase()))
        .join('.')
      const id = pathToId(dotPath.split('.'))
      lengths.push({ id, value: `${num}px` })
    }
  }

  // ───── textStyles: compound leaves with {fontFamily, fontSize, ...} ─────
  // Pre-resolve panda fonts aliases like `{fonts.sans}` to a single Slint-
  // friendly font family (Slint `string`, not a CSS-style fallback list —
  // the OS font-discovery is fontconfig and the Slint Text only honours one
  // family at a time, so we strip to the first quoted token).
  const fontsResolved = new Map<string, string>()
  if (input.fonts) {
    for (const [k, v] of Object.entries(input.fonts)) {
      if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
        const raw = (v as { value: unknown }).value
        if (typeof raw === 'string') {
          const m = raw.match(/^\s*"([^"]+)"/)
          fontsResolved.set(k, m ? m[1] : raw)
        }
      }
    }
  }
  const resolveFontFamily = (raw: string): string => {
    const m = raw.match(/^\{fonts\.([^}]+)\}$/)
    if (m && fontsResolved.has(m[1])) return fontsResolved.get(m[1])!
    const direct = raw.match(/^"([^"]+)"/)
    return direct ? direct[1] : raw
  }

  const textStyles: TextStyleLeaf[] = []
  const walkTextStyles = (cat: unknown, path: string[]) => {
    if (!cat || typeof cat !== 'object') return
    const o = cat as Record<string, unknown>
    if ('value' in o) {
      const v = o.value as Record<string, unknown> | undefined
      if (!v) return
      const ff = typeof v.fontFamily === 'string' ? resolveFontFamily(v.fontFamily) : ''
      const fs = typeof v.fontSize === 'string' ? remToPx(v.fontSize, remBase) : '0px'
      const lh = typeof v.lineHeight === 'string' ? remToPx(v.lineHeight, remBase) : '0px'
      const fw = typeof v.fontWeight === 'string' ? parseInt(v.fontWeight, 10)
        : typeof v.fontWeight === 'number' ? v.fontWeight
        : 400
      textStyles.push({ id: pathToId(path), fontFamily: ff, fontSize: fs, fontWeight: fw, lineHeight: lh })
      return
    }
    for (const [k, child] of Object.entries(o)) walkTextStyles(child, [...path, k])
  }
  walkTextStyles(input.textStyles, [])

  // De-dupe lengths by id — radii/spacing/sizes can overlap (e.g. spacing
  // and sizes share figma's number scale). First write wins; we log the rest.
  const seen = new Set<string>()
  const uniqLengths: Leaf[] = []
  for (const l of lengths) {
    if (seen.has(l.id)) continue
    seen.add(l.id)
    uniqLengths.push(l)
  }

  colors.sort((a, b) => a.id.localeCompare(b.id))
  uniqLengths.sort((a, b) => a.id.localeCompare(b.id))
  textStyles.sort((a, b) => a.id.localeCompare(b.id))

  const lines: string[] = []
  lines.push('// AUTO-GENERATED by pixpec slint emitter (build-tokens).')
  lines.push('// Do not edit by hand. Regenerate from the design-system token source.')
  lines.push('')
  if (textStyles.length) {
    lines.push('export struct TextStyle {')
    lines.push('    font-family: string,')
    lines.push('    font-size: length,')
    lines.push('    font-weight: int,')
    lines.push('    line-height: length,')
    lines.push('}')
    lines.push('')
  }
  lines.push('export global Tokens {')
  for (const c of colors) lines.push(`    in property <color> ${c.id}: ${c.value};`)
  if (colors.length && uniqLengths.length) lines.push('')
  for (const l of uniqLengths) lines.push(`    in property <length> ${l.id}: ${l.value};`)
  if ((colors.length || uniqLengths.length) && textStyles.length) lines.push('')
  for (const t of textStyles) {
    lines.push(`    in property <TextStyle> ${t.id}: {`)
    lines.push(`        font-family: "${t.fontFamily}",`)
    lines.push(`        font-size: ${t.fontSize},`)
    lines.push(`        font-weight: ${t.fontWeight},`)
    lines.push(`        line-height: ${t.lineHeight},`)
    lines.push('    };')
  }
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}
