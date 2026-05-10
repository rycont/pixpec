/**
 * `pixpec init <componentId>` — scaffold a component directory from Figma.
 *
 * Reads `pixpec.toml` from cwd (or walks up). Fetches component metadata via
 * cfigma; auto-generates props type + cases from variants; exports each
 * variant PNG into `src/components/<Name>/figma/`.
 *
 * Files generated under `<componentsDir>/<Name>/`:
 *   impl.ts    — props interface + render stub (TODO body)
 *   cases.ts   — auto-filled from variants
 *   index.ts   — defineComponent
 *   figma/     — exported variant PNGs (one per case)
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  fetchComponentMeta,
  listFigmaTabs,
  scanAllOpenTabsForInit,
  type FigmaComponentMeta,
  type FigmaExposedInstanceSchema,
  type FigmaPropertyDefinition,
  type FigmaPropValue,
  type FigmaVariantMeta,
  type ChildVariationSample,
} from './cfigma-meta.ts'
import type { FigmaInstanceRaw } from './types.ts'
import type { IRComponent } from './generator/ir.ts'

export interface PixpecConfig {
  figmaFileId: string
  /** Primary tab pattern — used by single-target commands (dump-figma,
   * breakdown-prepare default). Equal to `tabPatterns[0]`. */
  tabPattern: string
  /** All tab patterns the project may need to talk to. init walks this list
   * trying each until it finds the requested componentId (so a DS that
   * pulls masters from a separate library file can declare both). Falls
   * back to `[tabPattern]` for legacy single-tab toml. */
  tabPatterns: string[]
  /** Where component directories live. Default `src/components`. */
  componentsDir?: string
  /** Override cfigma binary path. */
  cfigmaBin?: string
  /** Default cfigma export scale. Default 2 (matches runner default). */
  scale?: number
  /** cfigma bridge URL. Default http://127.0.0.1:9876. */
  bridge?: string
  /** REM base in CSS px. Default 16 (matches CSS default html font-size).
   * Codegen emits all numeric figma-px values as `(value / remBase)rem`, so
   * a verify harness that scales html font-size by N× supersamples the
   * layout uniformly. Used to dodge Skia's dpr-dependent glyph advance:
   * scaling rem ×4 with dpr=2 yields 8× device-px-per-figma-unit (same as
   * dpr=8 supersample) but text advance is computed at dpr=2 precision. */
  remBase?: number
}

/** Walk up from cwd until `pixpec.toml` is found. Exported for DS-side scripts. */
export async function loadConfig(start: string = process.cwd()): Promise<{
  cfg: PixpecConfig
  root: string
}> {
  let dir = resolve(start)
  while (true) {
    const p = join(dir, 'pixpec.toml')
    if (existsSync(p)) {
      const raw = await readFile(p, 'utf8')
      const parsed = parseToml(raw) as Record<string, unknown>
      if (typeof parsed.figmaFileId !== 'string')
        throw new Error(`${p}: missing figmaFileId`)
      // Accept either `tabPattern: string` (legacy single) or
      // `tabPatterns: string[]` (multi-tab projects pulling from a library).
      const tabPatterns: string[] = Array.isArray(parsed.tabPatterns)
        ? parsed.tabPatterns.filter((x): x is string => typeof x === 'string')
        : typeof parsed.tabPattern === 'string'
          ? [parsed.tabPattern]
          : []
      if (tabPatterns.length === 0)
        throw new Error(`${p}: missing tabPattern (or tabPatterns array)`)
      const cfg: PixpecConfig = {
        figmaFileId: parsed.figmaFileId,
        tabPattern: tabPatterns[0],
        tabPatterns,
        componentsDir:
          typeof parsed.componentsDir === 'string'
            ? parsed.componentsDir
            : 'src/components',
        cfigmaBin:
          typeof parsed.cfigmaBin === 'string' ? parsed.cfigmaBin : undefined,
        scale: typeof parsed.scale === 'number' ? parsed.scale : 2,
        bridge: typeof parsed.bridge === 'string' ? parsed.bridge : undefined,
        remBase: typeof parsed.remBase === 'number' ? parsed.remBase : 16,
      }
      return { cfg, root: dir }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('pixpec.toml not found (searched up from ' + start + ')')
    }
    dir = parent
  }
}

/** Make a filesystem-safe identifier from a Figma name. */
function sanitize(name: string): string {
  return (
    name
      .normalize('NFC')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[\/\\]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9._\-ᄀ-ᇿ㄰-㆏가-힯一-鿿]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_.]+|[_.]+$/g, '') || 'unnamed'
  )
}

/** PascalCase the component name for TS identifiers. */
function pascalize(name: string): string {
  const s = sanitize(name)
  return s
    .split(/[_\-]+/)
    .map((p) => (p.length > 0 ? p[0].toUpperCase() + p.slice(1) : ''))
    .join('') || 'Component'
}

function propName(name: string): string {
  const stripped = name
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/#[^#]*$/, '')
    .trim()
  const parts = stripped
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  if (!parts.length) return 'prop'
  const [first, ...rest] = parts
  const lowerFirst = first[0].toLowerCase() + first.slice(1)
  const normalized = [
    lowerFirst,
    ...rest.map((p) => p[0].toUpperCase() + p.slice(1)),
  ].join('')
  return normalized === 'style' ? 'styleVariant' : normalized
}

function cleanControlValue<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') as T
  }
  if (Array.isArray(value)) return value.map(cleanControlValue) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cleanControlValue(v)]),
    ) as T
  }
  return value
}

function normalizePropRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  const used = new Set<string>()
  for (const [rawName, value] of Object.entries(record)) {
    const base = propName(rawName)
    let name = base
    let i = 2
    while (used.has(name)) name = `${base}${i++}`
    used.add(name)
    out[name] = cleanControlValue(value)
  }
  return out
}

function normalizeMetaProps(meta: FigmaComponentMeta): FigmaComponentMeta {
  return {
    ...meta,
    propertyDefinitions: normalizePropRecord(meta.propertyDefinitions),
    variants: meta.variants.map((variant) => ({
      ...variant,
      propValues: normalizePropRecord(variant.propValues),
    })),
  }
}

function tsTypeForProp(def: FigmaPropertyDefinition): string {
  switch (def.type) {
    case 'VARIANT':
      if (def.variantOptions && def.variantOptions.length > 0) {
        return def.variantOptions.map((v) => JSON.stringify(cleanControlValue(v))).join(' | ')
      }
      return 'string'
    case 'TEXT':
      return 'string'
    case 'BOOLEAN':
      return 'boolean'
    case 'INSTANCE_SWAP':
      // ReactNode is the broad interpretation; user can narrow per-component.
      return 'ReactNode'
  }
}

/** Mirror walker's `pixpecSetProp`: store each componentProperty value
 * under its full ("Status#1234:0"), short ("Status"), and camelCase
 * ("status") forms so a generated propsFromFigma can read whichever
 * form it picked. Used by init when it needs to hydrate a scanned
 * instance without re-running the whole walker. */
function normalizeRawProps(componentProperties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(componentProperties)) {
    out[name] = value
    const short = String(name).split('#')[0]
    if (!(short in out)) out[short] = value
    const stripped = short.replace(/[\x00-\x1f\x7f]/g, '').trim()
    const parts = stripped.split(/[^A-Za-z0-9]+/).filter(Boolean)
    if (parts.length) {
      const camel = parts[0][0].toLowerCase() + parts[0].slice(1)
        + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('')
      if (!(camel in out)) out[camel] = value
    }
  }
  return out
}

function literalForValue(
  def: FigmaPropertyDefinition,
  value: FigmaPropValue,
): string {
  if (value === null || value === undefined) {
    if (def.type === 'INSTANCE_SWAP') return 'null /* TODO: <Icon/> ... */'
    if (def.type === 'BOOLEAN') return 'false'
    if (def.type === 'TEXT') return '""'
    return '""'
  }
  if (def.type === 'INSTANCE_SWAP') {
    const v = value as { mainComponentName?: string | null; mainComponentId?: string | null }
    return `null /* TODO: replace with imported component (was Figma instance "${v.mainComponentName ?? '?'}" id=${v.mainComponentId ?? '?'}) */`
  }
  if (def.type === 'BOOLEAN') return value ? 'true' : 'false'
  return JSON.stringify(cleanControlValue(value))
}

function variantKey(v: FigmaVariantMeta): string {
  // Prefer the Figma variant name (e.g. "size=md, state=default"); fall back to id.
  return sanitize(v.name) || v.id.replace(/:/g, '-')
}

/** Whether `name` is a bare JS identifier — emit unquoted when so. */
function isIdent(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
}

function propsKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name)
}

/** Build TS field lines from a propertyDefinitions map (used both for the
 * top-level component interface and for each exposed nested-instance slot). */
function defsToFieldLines(defs: Record<string, FigmaPropertyDefinition>): string[] {
  return Object.entries(defs).map(([name, def]) => {
    const t = tsTypeForProp(def)
    const tag = def.type === 'INSTANCE_SWAP' ? '  // INSTANCE_SWAP — narrow type if needed' : ''
    return `  ${propsKey(name)}?: ${t}${tag}`
  })
}

/** A nested-instance slot's TS interface name, derived from componentSet name
 * (e.g. "Icon" → "ButtonFullRoundIconProps"). Falls back to the slot key if
 * there is no main component name. */
function nestedInterfaceName(componentName: string, slotKey: string, schema: FigmaExposedInstanceSchema): string {
  const base = schema.mainName ? pascalize(schema.mainName) : pascalize(slotKey)
  return `${componentName}${base}Props`
}

function generateProps(
  componentName: string,
  defs: Record<string, FigmaPropertyDefinition>,
  nestedSchemas: Record<string, FigmaExposedInstanceSchema>,
  detectedItemsProp?: {
    propName: string
    childComponentName: string
    varyingHydratedKeys: string[]
  },
): string {
  const ownLines = defsToFieldLines(defs)

  // Group nested slots by main componentSet key — slots referencing the
  // same DS component (e.g. left+right Icon) share one sub-interface.
  const interfaceByKey = new Map<string, { name: string; schema: FigmaExposedInstanceSchema; sampleSlot: string }>()
  const slotToInterfaceName: Record<string, string> = {}
  for (const [slotKey, schema] of Object.entries(nestedSchemas)) {
    const groupKey = schema.mainKey ?? slotKey  // ungrouped fallback
    if (!interfaceByKey.has(groupKey)) {
      const name = nestedInterfaceName(componentName, slotKey, schema)
      interfaceByKey.set(groupKey, { name, schema, sampleSlot: slotKey })
    }
    slotToInterfaceName[slotKey] = interfaceByKey.get(groupKey)!.name
  }

  const nestedLines = Object.keys(nestedSchemas).map((slotKey) => {
    const ifaceName = slotToInterfaceName[slotKey]
    return `  ${propsKey(slotKey)}?: ${ifaceName}`
  })

  const subInterfaceBlocks = [...interfaceByKey.values()].map(({ name, schema }) => {
    const lines = defsToFieldLines(schema.propertyDefinitions)
    const sourceTag = schema.mainName ? ` (figma "${schema.mainName}")` : ''
    return `/** Exposed nested-instance slot${sourceTag}. */\nexport interface ${name} {\n${lines.join('\n') || '  // no properties'}\n}`
  })

  // Container pattern (auto-detected): props subset = the keys observed to
  // vary across same-kind sibling instances. Pulled FROM the child's
  // already-generated `<Child>Props` interface so types stay in sync —
  // `Pick<>` on the child means re-init of either component refreshes both.
  let containerImport = ''
  let containerLine = ''
  if (detectedItemsProp) {
    const camelChild = detectedItemsProp.childComponentName.replace(/[^A-Za-z0-9]/g, '')
    const propsTypeName = `${camelChild}Props`
    // Pick is computed bottom-up: init hydrated each scanned child via the
    // child's own propsFromFigma and kept the keys whose values varied
    // across siblings. Re-init either side to refresh the surface.
    const keys = detectedItemsProp.varyingHydratedKeys
    containerImport = `import type { ${propsTypeName} } from '../${camelChild}/props.ts'\n`
    containerLine = `  ${detectedItemsProp.propName}?: Array<Pick<${propsTypeName}, ${keys.map((k) => JSON.stringify(k)).join(' | ')}>>`
  }

  const propLines = [...ownLines, ...nestedLines, ...(containerLine ? [containerLine] : [])].join('\n')
  const allDefs = [defs, ...[...interfaceByKey.values()].map(v => v.schema.propertyDefinitions)]
  const hasInstanceSwap = allDefs.some(d => Object.values(d).some((p) => p.type === 'INSTANCE_SWAP'))
  const reactNodeImport = hasInstanceSwap ? `import type { ReactNode } from 'react'\n` : ''
  const subBlock = subInterfaceBlocks.length ? `\n${subInterfaceBlocks.join('\n\n')}\n` : ''
  const headerImports = `${reactNodeImport}${containerImport}`
  return `${headerImports}${headerImports ? '\n' : ''}/**
 * AUTO-GENERATED from figma componentPropertyDefinitions for ${componentName}.
 * Re-run \`pixpec init\` to refresh after figma changes. Hand-edits here will
 * be overwritten — narrow types in impl.tsx instead.
 */
export interface ${componentName}Props {
${propLines}
}
${subBlock}`
}

function generateImpl(componentName: string): string {
  return `import type { FC } from 'react'
import type { ${componentName}Props } from './props.ts'

/**
 * STUB — synthesize from \`./generated/<variantId>.tsx\` after running
 * breakdown for every variant in cases.ts. Compose objectively: dispatch
 * on the variant prop tuple to each generated tree as-is. The verify step
 * (pixpec measure) is the gate.
 */
export const impl: FC<${componentName}Props> = (_props) => {
  return <div>TODO: synthesize ${componentName} from ./generated/*.tsx</div>
}

export type { ${componentName}Props }
`
}

function generateDefaults(
  componentName: string,
  defs: Record<string, FigmaPropertyDefinition>,
): string {
  const lines = Object.entries(defs).map(([name, def]) => {
    return `  ${propsKey(name)}: ${literalForValue(def, def.defaultValue as FigmaPropValue)},`
  })
  return `import type { ${componentName}Props } from './props.ts'

/** Defaults pulled from figma componentPropertyDefinitions[].defaultValue —
 * used by codegen as the "what you'd get without overriding" baseline so
 * generated JSX can elide redundant prop emissions on instance call sites. */
export const defaults: Required<Pick<${componentName}Props, ${
    Object.keys(defs).map((k) => JSON.stringify(k)).join(' | ') || 'never'
  }>> = {
${lines.join('\n')}
}
`
}

/** A generated case row — used both for master variants (dim unknown,
 * fileKey = library file) and for real usage instances (with figma dim
 * and the consuming file's fileKey). `signature` is the dedup key. */
interface CaseRow {
  /** Combined `<fileKey>:<nodeId>` — the only addressable form Case
   * carries now (matches the `pixpec init` CLI form). */
  figmaId: string
  /** True for variant-row entries (figma master nodes). Emit as
   * `isMainCase: true` so consumers can pick the bucket's master without
   * a second sweep through the variants list. */
  isMain?: boolean
  /** For variant rows: the figma cross-file durable key — Variant.key in
   * the emitted cases.ts. For usage rows: the matching master variant's
   * key (= `inst.mainComponent.key`), used for bucketing under the
   * right variant without any per-file id translation. */
  variantKey?: string
  /** For variant rows only: per-node bindings spec emitted as
   * `Variant.bindings` in cases.ts. generate threads this through the
   * walker so IR nodes get parametric annotations. */
  bindings?: Record<string, { attr?: { text?: string; visible?: string }; instanceProps?: Record<string, string> }>
  /** Pre-rendered TS object literal (already-formatted prop entries
   * with `literalForValue`-friendly value forms). */
  propsLiteral: string
  /** JSON.stringify of an order-stable {props, width, height} blob. Two
   * rows with the same signature collapse to one (the first wins). */
  signature: string
  /** When the figma usage overrode the root component's sizing (instance
   * dim differs from master dim), init emits a wrapper that locks the
   * chromium render to the same width/height — otherwise hug-content
   * impl would diverge from figma's fixed-size frame. Stored as the
   * literal source of the wrapper expression so generateCases can drop
   * it straight into the case object. */
  wrapperLiteral?: string
}

function stableSignature(props: Record<string, unknown>, width?: number, height?: number): string {
  const sorted = Object.keys(props).sort().reduce<Record<string, unknown>>((a, k) => { a[k] = props[k]; return a }, {})
  return JSON.stringify({ p: sorted, w: width ?? null, h: height ?? null })
}

function generateCases(
  componentName: string,
  fileKey: string,
  meta: FigmaComponentMeta,
  usageRows: CaseRow[] = [],
  // Synthetic-prop hooks detected by usage scan — init injects each master
  // variant's actual TEXT chars / nested-INSTANCE values so master cases
  // render identically to figma's master node (otherwise impl falls back to
  // defaults that are sample-derived, not master-authored).
  detectedLabelProp?: { name: string },
  detectedNestedProps: Array<{ propName: string; layerName: string; propKey: string }> = [],
  // Map of prop key → default value (built from augmentedDefs at the call
  // site). Variant rows drop fields equal to this map so the emitted
  // master case props stay slim — impl spreads `{...defaults, ...props}`
  // and recovers any dropped fields from defaults.ts.
  defaultsMap: Record<string, unknown> = {},
): string {
  // Master variants live in the library file (`fileKey` arg); usage rows
  // already arrived with their own `figmaId` (per-tab fileKey baked in).
  const variantRows: CaseRow[] = meta.variants.map((v) => {
    // Build full hydrated prop set first; emit only the diff vs defaults
    // (computed below from augmentedDefs). Mirrors usecase emit so case
    // props stay minimal across both layers.
    const allProps: Record<string, unknown> = { ...v.propValues }
    if (detectedLabelProp && v.textLayers) {
      const chars = v.textLayers[detectedLabelProp.name]
      if (chars !== undefined) allProps.label = chars
    }
    for (const np of detectedNestedProps) {
      const val = v.nestedProps?.[np.layerName]?.[np.propKey]
      if (val !== undefined) allProps[np.propName] = val
    }
    if (v.layout) {
      const px2rem = (px: number) => `${+(px / 16).toFixed(6)}rem`
      for (const k of ['paddingTop','paddingRight','paddingBottom','paddingLeft','gap'] as const) {
        const val = v.layout[k]
        if (val != null) allProps[k] = px2rem(val)
      }
    }
    // Drop fields whose value equals the default impl will spread.
    const slimProps: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(allProps)) {
      const defVal = defaultsMap[k] as unknown
      if (defVal === undefined || JSON.stringify(defVal) !== JSON.stringify(val)) {
        slimProps[k] = val
      }
    }
    const propEntries = Object.entries(slimProps).map(([name, value]) => {
      const def = meta.propertyDefinitions[name]
      if (!def) return `    ${name}: ${JSON.stringify(value)}`
      return `    ${propsKey(name)}: ${literalForValue(def, value as FigmaPropValue)}`
    })
    // Lock master variant case to its figma dim so the impl's CSS-flex
    // hug doesn't drift sub-pixel from figma's layout-engine hug.
    // boxWrapper rem-converts internally so the verify-mode supersample
    // applies to the wrapper alongside the codegen'd JSX.
    const wrapperLiteral = (v.width != null && v.height != null)
      ? `boxWrapper({ width: ${v.width}, height: ${v.height} })`
      : undefined
    // Per-node bindings — for each TEXT layer matching detectedLabelProp
    // and each nested INSTANCE matching detectedNestedProps, record the
    // figma node id with its owner-prop key. generate uses these to
    // annotate IR nodes during walk → codegen emits {props.<key>}.
    const bindings: Record<string, { attr?: { text?: string; visible?: string }; instanceProps?: Record<string, string> }> = {}
    if (detectedLabelProp && v.textNodes) {
      for (const tn of v.textNodes) {
        if (tn.name === detectedLabelProp.name) {
          bindings[tn.id] = bindings[tn.id] ?? {}
          bindings[tn.id].attr = { ...(bindings[tn.id].attr ?? {}), text: 'label' }
        }
      }
    }
    if (v.nestedNodes) {
      for (const nn of v.nestedNodes) {
        for (const np of detectedNestedProps) {
          if (nn.name !== np.layerName) continue
          if (!(np.propKey in nn.props)) continue
          bindings[nn.id] = bindings[nn.id] ?? {}
          bindings[nn.id].instanceProps = {
            ...(bindings[nn.id].instanceProps ?? {}),
            [np.propKey]: np.propName,
          }
        }
      }
    }
    // Visibility bindings — each node whose `visible` is bound to an owner
    // boolean prop (e.g. an Icon hidden when leftIcon=false). codegen wraps
    // the JSX with `{<propKey> !== false && ...}`.
    if (v.visibilityNodes) {
      for (const vn of v.visibilityNodes) {
        const propKey = propName(vn.propRef)
        bindings[vn.id] = bindings[vn.id] ?? {}
        bindings[vn.id].attr = { ...(bindings[vn.id].attr ?? {}), visible: propKey }
      }
    }
    return {
      figmaId: `${fileKey}:${v.id}`,
      variantKey: v.key,
      propsLiteral: `{\n${propEntries.join(',\n')}\n    }`,
      bindings: Object.keys(bindings).length > 0 ? bindings : undefined,
      // Include w/h so two visually-identical masters with different dims
      // (e.g. Tab_Item Status=true at 96×64 vs same props at 132×64)
      // don't collapse to one variant.
      signature: stableSignature(allProps, v.width, v.height),
      wrapperLiteral,
      isMain: true,
    }
  })
  // Hierarchical model:
  //   variants — every master variant of this component. Each carries a
  //              nested `usecases` array of figma instance occurrences
  //              that map to it (instance.mainComponent.id === variant
  //              figmaId). breakdown + codegen iterate the variant level;
  //              usecases inside feed runtime data + optional regression.
  // Composition (impl synthesis) consumes the variant level, never the
  // nested usecases — those just describe how designers actually used
  // each variant.
  const dedup = (rows: CaseRow[]): CaseRow[] => {
    const seen = new Set<string>()
    return rows.filter((r) => {
      if (seen.has(r.signature)) return false
      seen.add(r.signature)
      return true
    })
  }
  // Variant is a pure key bucket — no figma id, no render data of its
  // own. The master figma node becomes ONE of the bucket's `usecases`
  // (the entry with isMainCase). Bucketing matches by figma's cross-file
  // durable variant key — usecase.variantKey === variant.key — so no
  // per-file id translation is ever needed.
  const allUsecases = dedup([...variantRows, ...usageRows])
  const knownVariantKeys = new Set(variantRows.map((v) => v.variantKey).filter((k): k is string => !!k))
  const usecasesByVariant = new Map<string, CaseRow[]>()
  for (const u of allUsecases) {
    const key = u.variantKey && knownVariantKeys.has(u.variantKey) ? u.variantKey : '<unknown>'
    if (!usecasesByVariant.has(key)) usecasesByVariant.set(key, [])
    usecasesByVariant.get(key)!.push(u)
  }
  const renderUsecase = (r: CaseRow) => {
    const wrap = r.wrapperLiteral ? `\n        wrapper: ${r.wrapperLiteral},` : ''
    const main = r.isMain ? `\n        isMainCase: true,` : ''
    return `      {
        props: ${r.propsLiteral.replace(/\n/g, '\n    ')},
        figmaId: ${JSON.stringify(r.figmaId)},${wrap}${main}
      }`
  }
  const variantByKey = new Map(variantRows.filter((v) => v.variantKey).map((v) => [v.variantKey!, v]))
  const renderVariant = (variantKey: string) => {
    const variant = variantByKey.get(variantKey)
    const us = usecasesByVariant.get(variantKey) ?? []
    const bindingsLit = variant?.bindings
      ? `\n    bindings: ${JSON.stringify(variant.bindings, null, 2).replace(/\n/g, '\n    ')},`
      : ''
    return `  {
    key: ${JSON.stringify(variantKey)},${bindingsLit}
    usecases: [
${us.map(renderUsecase).join(',\n')},
    ],
  }`
  }
  const variantKeys = variantRows.map((v) => v.variantKey).filter((k): k is string => !!k)
  const needsBoxWrapper = allUsecases.some((r) => r.wrapperLiteral)
  const wrapperImport = needsBoxWrapper ? `import { boxWrapper } from 'pixpec/spec'\n` : ''
  return `${wrapperImport}import type { Variant } from 'pixpec/spec'
import type { ${componentName}Props } from './props.ts'

/** Master variants — what breakdown / codegen / verify iterate. Each
 *  carries a nested usecases array of figma instance occurrences that
 *  map to it (deduped by props+dim). impl is composed from the per-variant
 *  generated trees; usecases feed the runtime + optional regression. */
export const variants: Variant<${componentName}Props>[] = [
${variantKeys.map(renderVariant).join(',\n')},
]
`
}

function generateIndex(componentName: string, componentSetKey: string | undefined,
                        componentSetId: string | undefined,
                        defs: Record<string, FigmaPropertyDefinition>,
                        autoLabelLayerName?: string,
                        detectedItemsProp?: {
                          propName: string
                          childComponentName: string
                          varyingHydratedKeys: string[]
                        },
                        detectedNestedProps: Array<{ propName: string; layerName: string; propKey: string }> = []): string {
  // raw.props is already pre-cleaned (walker's pixpecSetProp strips control
  // chars). Just pass through with a type cast to the prop's narrowed type.
  // INSTANCE_SWAP needs user-supplied wiring → emit undefined as a TODO marker.
  // The synthetic 'label' prop (if init detected the single-text-override
  // pattern) reads walker's textOverrides[descId] map instead of raw.props
  // — designer didn't expose the text via figma componentProperties, so
  // walker keys it by the master descendant id instead.
  const propMappings = Object.entries(defs).map(([name, def]) => {
    const k = propsKey(name)
    if (name === 'label' && autoLabelLayerName) {
      // walker keys textOverrides by the TEXT layer NAME, which stays
      // consistent across master variants (figma copies child names when
      // authoring variants) — no per-variant id enumeration needed.
      return `    ${k}: raw.textOverrides?.[${JSON.stringify(autoLabelLayerName)}] as ${componentName}Props[${JSON.stringify(name)}],`
    }
    // Auto-detected nested INSTANCE prop — read from
    // raw.nestedProps[layerName][propKey], populated by walker.
    const nested = detectedNestedProps.find((n) => n.propName === name)
    if (nested) {
      return `    ${k}: raw.nestedProps?.[${JSON.stringify(nested.layerName)}]?.[${JSON.stringify(nested.propKey)}] as ${componentName}Props[${JSON.stringify(name)}],`
    }
    const access = `raw.props[${JSON.stringify(name)}]`
    if (def.type === 'INSTANCE_SWAP') {
      return `    ${k}: undefined, // INSTANCE_SWAP — wire to a React node lookup`
    }
    return `    ${k}: ${access} as ${componentName}Props[${JSON.stringify(name)}],`
  }).join('\n')
  // Container array prop — auto-detected. propsFromFigma walks the IR
  // children (each one is a hydrated nested instance with `.props`
  // already populated by its OWN propsFromFigma) and pulls only the
  // varying keys into a Pick<>-shaped object per child.
  let containerMapping = ''
  if (detectedItemsProp) {
    // Child IR's `.props` is already hydrated by the child's own
    // propsFromFigma → it IS a `<Child>Props`. Pick only the keys init
    // observed to vary across siblings, matching the parent's Pick<>
    // type: runtime shape stays in lock-step with the declared interface.
    const pickFields = detectedItemsProp.varyingHydratedKeys
      .map((k) => `${k}: c.props?.[${JSON.stringify(k)}]`)
      .join(', ')
    containerMapping = `\n    ${detectedItemsProp.propName}: (node?.children ?? [])
      .filter((c) => c.kind === 'component')
      .map((c) => ({ ${pickFields} })) as ${componentName}Props[${JSON.stringify(detectedItemsProp.propName)}],`
  }
  const fnSig = detectedItemsProp ? '(raw, node)' : '(raw)'
  const figmaBlock = componentSetKey
    ? `,
  figma: {
    componentSetKey: ${JSON.stringify(componentSetKey)},${componentSetId ? `\n    componentSetId: ${JSON.stringify(componentSetId)},` : ''}
    propsFromFigma: ${fnSig} => ({
${propMappings}${containerMapping}
    }),
  }`
    : ''
  return `import { defineComponent } from 'pixpec/spec'
import { variants } from './cases.ts'
import { defaults } from './defaults.ts'
import type { ${componentName}Props } from './props.ts'

export type { ${componentName}Props }
export { defaults }

export const ${componentName} = defineComponent<${componentName}Props>({
  name: ${JSON.stringify(componentName)},
  variants,
  defaults${figmaBlock},
})
`
}

export interface InitResult {
  componentDir: string
  componentName: string
  variantCount: number
  variantIds: string[]
}

export async function init(opts: {
  componentId: string
  /** Override config root (otherwise walked up from cwd). */
  cwd?: string
  /** Skip overwriting impl.tsx when it exists (preserves user code).
   * cases.ts / defaults.ts / index.ts are always rewritten — they mirror figma. */
  skipExisting?: boolean
}): Promise<InitResult> {
  const { cfg, root } = await loadConfig(opts.cwd)
  // componentId MUST be `<fileKey>:<nodeId>` (e.g.
  // "XuZaMcO3FuA8B0GEZRYvLG:2128:1609"). Figma file keys are 20+
  // alphanumeric chars; node ids contain a colon. Splits on the FIRST
  // colon. Pinning on fileKey eliminates the ambiguous-tab guessing the
  // older bare-nodeId form required.
  const firstColon = opts.componentId.indexOf(':')
  const head = firstColon > 0 ? opts.componentId.slice(0, firstColon) : ''
  const nodeId = firstColon > 0 ? opts.componentId.slice(firstColon + 1) : ''
  if (!head || !nodeId.includes(':') || !/^[A-Za-z0-9]{20,}$/.test(head)) {
    throw new Error(`pixpec init: componentId must be in <fileKey>:<nodeId> form (e.g. "XuZaMcO3FuA8B0GEZRYvLG:2128:1609"). Got: ${opts.componentId}`)
  }
  const explicitFileKey = head
  const tabs = await listFigmaTabs({ cfigmaBin: cfg.cfigmaBin })
  const tab = tabs.find((t) => t.key === explicitFileKey)
  if (!tab) throw new Error(`pixpec init: no open figma tab matches fileKey ${explicitFileKey} (open tabs: ${tabs.map((t) => `${t.title} (${t.key})`).join(', ') || '<none>'})`)
  const meta = await fetchComponentMeta({ tabPattern: tab.key, componentId: nodeId, cfigmaBin: cfg.cfigmaBin })
  const normalizedMeta = normalizeMetaProps(meta)
  const componentName = pascalize(normalizedMeta.name)
  const componentsDir = resolve(root, cfg.componentsDir ?? 'src/components')
  const componentDir = join(componentsDir, componentName)
  // Wipe any prior scaffolding so figma is the only source of truth on
  // re-init. impl.tsx is opt-in preserved via skipExisting; everything else
  // is regenerated.
  let preservedImpl: string | undefined
  if (existsSync(componentDir)) {
    if (opts.skipExisting) {
      const implP = join(componentDir, 'impl.tsx')
      if (existsSync(implP)) preservedImpl = await readFile(implP, 'utf8')
    }
    await rm(componentDir, { recursive: true, force: true })
  }
  await mkdir(componentDir, { recursive: true })
  await mkdir(join(componentDir, 'generated'), { recursive: true })

  const writeStub = async (p: string, body: string, preserved: string | undefined) => {
    await writeFile(p, preserved ?? body)
  }
  // Aggregate exposed-instance schemas across all variants. All variants
  // of the same component should agree on the slot name + main key (figma
  // requires this), so first-seen wins.
  const nestedSchemas: Record<string, FigmaExposedInstanceSchema> = {}
  for (const v of normalizedMeta.variants) {
    for (const [slotKey, schema] of Object.entries(v.exposedSchemas ?? {})) {
      if (!nestedSchemas[slotKey]) nestedSchemas[slotKey] = schema
    }
  }

  // Auto-detect "the only descendant TEXT that varies across instance
  // usages" → expose as a `label` prop. Spares the design system author
  // from manually exposing TEXT properties in figma + plumbing
  // propsFromFigma. Scans every open figma tab so usages in any consuming
  // file count. Skipped silently when normalizedMeta.key is unset (no
  // ComponentSet → no instance fan-out to scan).
  // Single combined scan across all open tabs (parallel) — yields BOTH
  // label-detection summaries and child-variation samples in one pass.
  let detectedLabelProp: { name: string; sample: string } | undefined
  let scanResult: import('./cfigma-meta.ts').InitScanResult | undefined
  if (normalizedMeta.key) {
    try {
      const tScan = Date.now()
      scanResult = await scanAllOpenTabsForInit({
        componentSetKey: normalizedMeta.key,
        cfigmaBin: cfg.cfigmaBin,
      })
      console.log(`[init] instance scan complete (${Date.now() - tScan}ms): ${scanResult.textSummaries.length} text summaries, ${scanResult.childVariations.length} container parents`)
      // 20% threshold: only expose when ≥20% of usages override the value.
      const THRESHOLD = 0.2
      const total = scanResult.totalInstances || 1
      const variable = scanResult.textSummaries.filter((s) => s.overrideCount / total >= THRESHOLD)
      if (variable.length === 1) {
        const v = variable[0]
        detectedLabelProp = { name: v.descName, sample: v.samples[0] }
        console.log(`[init] detected single-text override pattern (${v.overrideCount}/${total} = ${(v.overrideCount / total * 100).toFixed(0)}%) → exposing as 'label' prop (layer name: ${JSON.stringify(v.descName)})`)
      } else if (variable.length > 1) {
        console.log(`[init] ${variable.length} descendant texts cross 20% override threshold — ambiguous, no auto-prop`)
      }
    } catch (e) {
      console.warn(`[init] instance scan failed: ${(e as Error).message}`)
    }
  }
  // Auto-expose nested INSTANCE component properties whose ≥20% of usages
  // override the master default. propsFromFigma reads them from
  // `raw.nestedProps[layerName][propKey]`. Prop name = camelCase of
  // `<layerName><PropKey>` (e.g. Icon's Type → `iconType`).
  type DetectedNestedProp = {
    /** TS prop name on the parent component. */
    propName: string
    /** figma layer name of the nested INSTANCE (e.g. "Icon"). */
    layerName: string
    /** Raw figma componentProperty key (e.g. "Type"). */
    propKey: string
    /** Distinct values seen across overrides. Used to emit a union TS type. */
    samples: unknown[]
  }
  const detectedNestedProps: DetectedNestedProp[] = []
  if (scanResult && scanResult.totalInstances > 0) {
    const THRESHOLD = 0.2
    // Skip nested-instance kinds already covered by the container pattern
    // (e.g. Tab.tabItems already exposes Tab_Item state — exposing
    // `tabItemStatus` on top is redundant). Container child layer names
    // come from sample[0].name → grab from childComponentSetName.
    const containerChildSetName = scanResult.childVariations.length > 0
      ? scanResult.childVariations[0].childComponentSetName
      : null
    for (const ns of scanResult.nestedPropSummaries) {
      // Threshold against this nested kind's own occurrences (e.g. 47
      // Tabs × 3 Tab_Items = 141), not the parent count.
      if (ns.instanceCount === 0 || ns.overrideCount / ns.instanceCount < THRESHOLD) continue
      if (containerChildSetName && ns.layerName === containerChildSetName) continue
      // camelCase: lowercase first of layer + camelCase of propKey.
      // Strip figma key suffix (`#2137:0`) before camelCase — those are
      // figma internal property ids, not part of the prop name.
      const cleanPropKey = ns.propKey.replace(/#[^#]*$/, '')
      const propName = (ns.layerName[0].toLowerCase() + ns.layerName.slice(1)).replace(/[^A-Za-z0-9]/g, '') +
        cleanPropKey.replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^(.)/, (m) => m.toUpperCase())
      detectedNestedProps.push({ propName, layerName: ns.layerName, propKey: ns.propKey, samples: ns.samples })
      console.log(`[init] detected nested override (${ns.overrideCount}/${ns.instanceCount} = ${(ns.overrideCount / ns.instanceCount * 100).toFixed(0)}%) → exposing '${propName}' (nested ${ns.layerName}.${ns.propKey})`)
    }
  }
  // Splice the synthetic 'label' definition onto the propertyDefinitions so
  // generateProps emits the prop alongside figma's own componentProperties.
  // Defaults for synthetic props (`label`, nested-derived `iconType` etc.)
  // come from the FIRST master variant's authored values — that's the
  // canonical "what figma renders when you drop the master in" baseline.
  // Falls back to samples[0] from the usage scan only if the master itself
  // doesn't carry the layer/nested-instance (rare; means the variant has
  // a different structure than the usages init was scanning).
  const masterVariant = normalizedMeta.variants[0] as FigmaVariantMeta | undefined
  const augmentedDefs: Record<string, FigmaPropertyDefinition> = { ...normalizedMeta.propertyDefinitions }
  if (detectedLabelProp) {
    const masterChars = masterVariant?.textLayers?.[detectedLabelProp.name]
    augmentedDefs.label = {
      type: 'TEXT',
      defaultValue: masterChars ?? detectedLabelProp.sample,
    }
  }
  for (const np of detectedNestedProps) {
    const masterVal = masterVariant?.nestedProps?.[np.layerName]?.[np.propKey]
    augmentedDefs[np.propName] = {
      type: 'VARIANT',
      defaultValue: (masterVal ?? np.samples[0]) as FigmaPropValue,
      variantOptions: np.samples.filter((s): s is string => typeof s === 'string'),
    }
  }
  // Master variant autolayout (padding/gap) → defaults so impl spreads
  // them onto its root via `{ ...defaults, ...props }`. Stored as rem
  // strings to match the supersample-aware case props.
  if (masterVariant?.layout) {
    const px2rem = (px: number) => `${+(px / 16).toFixed(6)}rem`
    for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap'] as const) {
      const val = masterVariant.layout[k]
      if (val != null) {
        augmentedDefs[k] = { type: 'TEXT', defaultValue: px2rem(val) }
      }
    }
  }

  // ---- Detect "container of N same-kind children with varying props" ----
  // Scope (per user direction): only fire when ALL direct children of a
  // parent instance are INSTANCEs of one componentSet, AND at least one
  // componentProperty/text-override key varies across siblings within any
  // scanned parent. The varying keys + child component name become an
  // array prop on the parent (`<childName>s?: Array<{...}>`) plus a
  // generated propsFromFigma that walks `node.children` in codegen.
  // Container pattern is fully bottom-up: the child component must
  // already be init'd (its `defineComponent` exists with a propsFromFigma
  // that knows how to map its own raw → typed Props). Init dynamically
  // imports the child, hydrates each scanned sibling with the child's
  // OWN propsFromFigma, then diffs the resulting typed objects to find
  // which child props vary across usages. That set becomes the parent's
  // `Pick<ChildProps, ...>` — derived from real hydrated values, not from
  // figma raw keys, so child-only knowledge (label layer name, nested
  // Icon→iconType remap, etc.) flows up correctly.
  let detectedItemsProp: undefined | {
    propName: string
    childComponentName: string
    childComponentSetKey: string
    /** Hydrated TS-prop keys whose values differ across at least one
     * sibling pair within a parent. These are the keys that go into
     * the parent's `Pick<ChildProps, ...>`. */
    varyingHydratedKeys: string[]
  }
  // Captured so the post-detect case generator can reuse the same child
  // hydrator (no need to re-import) when building usage-based cases.
  let childPropsFromFigma: ((raw: FigmaInstanceRaw, node?: IRComponent) => Record<string, unknown>) | undefined
  if (normalizedMeta.key && scanResult) {
    try {
      const samples = scanResult.childVariations
      const childKeys = new Set(samples.map((s) => s.childComponentSetKey).filter(Boolean) as string[])
      if (samples.length > 0 && childKeys.size === 1) {
        const childKey = [...childKeys][0]
        const childRawName = samples[0].childComponentSetName ?? samples[0].childComponentName ?? 'Child'
        const childComponentName = pascalize(childRawName)
        // Locate the already-init'd child dir and import its defineComponent.
        const childDir = join(componentsDir, childComponentName)
        const childIndex = join(childDir, 'index.ts')
        let childMod: { [k: string]: unknown }
        try {
          const { pathToFileURL } = await import('node:url')
          childMod = await import(pathToFileURL(childIndex).href) as { [k: string]: unknown }
        } catch (e) {
          throw new Error(
            `child component '${childComponentName}' must be init'd first ` +
            `(expected '${childIndex}'). Run \`pixpec init <fileKey>:${childKey}\` ` +
            `before initing this container. Underlying error: ${(e as Error).message}`,
          )
        }
        const childExport = childMod[childComponentName] as
          | { figma?: { propsFromFigma?: (raw: FigmaInstanceRaw, node?: IRComponent) => Record<string, unknown> } }
          | undefined
        const propsFromFigma = childExport?.figma?.propsFromFigma
        if (typeof propsFromFigma !== 'function') {
          throw new Error(`child '${childComponentName}' has no figma.propsFromFigma — re-init it`)
        }
        // Hydrate every scanned child via the child's own propsFromFigma,
        // then diff per-parent. Aggregate varying keys across all parents.
        const varyingHydrated = new Set<string>()
        const dummyRect = { x: 0, y: 0, width: 0, height: 0 }
        for (const s of samples) {
          if (s.children.length < 2) continue
          const hydrated = s.children.map((c) => {
            const raw: FigmaInstanceRaw = {
              id: '', name: '', mainComponentName: '', componentSetKey: childKey,
              props: normalizeRawProps(c.componentProperties) as Record<string, string | boolean>,
              exposed: [],
              textOverrides: c.textOverrides,
              nestedProps: c.nestedProps,
            }
            const node: IRComponent = {
              kind: 'component', componentSetKey: childKey, props: {},
              children: [], rect: dummyRect,
            } as unknown as IRComponent
            try { return propsFromFigma(raw, node) } catch { return {} }
          })
          const allKeys = new Set<string>()
          for (const h of hydrated) for (const k of Object.keys(h)) allKeys.add(k)
          for (const k of allKeys) {
            const vals = new Set(hydrated.map((h) => JSON.stringify(h[k] ?? null)))
            if (vals.size > 1) varyingHydrated.add(k)
          }
        }
        if (varyingHydrated.size > 0) {
          childPropsFromFigma = propsFromFigma
          const propName = (childComponentName[0].toLowerCase() + childComponentName.slice(1) + 's').replace(/[^A-Za-z0-9]/g, '')
          detectedItemsProp = {
            propName,
            childComponentName,
            childComponentSetKey: childKey,
            varyingHydratedKeys: [...varyingHydrated],
          }
          console.log(
            `[init] detected container pattern: ${samples.length} parent instance(s), ` +
            `all children are ${childComponentName} → exposing as ` +
            `'${propName}: Array<Pick<${childComponentName}Props, ${[...varyingHydrated].join(' | ')}>>' ` +
            `(hydrated via ${childComponentName}.propsFromFigma)`,
          )
        }
      }
    } catch (e) {
      console.warn(`[init] container-pattern scan failed: ${(e as Error).message}`)
    }
  }
  // impl.tsx is a stub (or preserved from a prior run via skipExisting).
  await writeStub(
    join(componentDir, 'impl.tsx'),
    generateImpl(componentName),
    preservedImpl,
  )
  // props.ts / cases.ts / defaults.ts / index.ts always rewritten — mirrors figma.
  // Format every emit with prettier so the output stays human-reviewable.
  const prettier = await import('prettier')
  const fmt = (src: string) =>
    prettier.format(src, { parser: 'typescript', semi: false, singleQuote: true, printWidth: 100 })
  await writeFile(
    join(componentDir, 'props.ts'),
    await fmt(generateProps(componentName, augmentedDefs, nestedSchemas, detectedItemsProp)),
  )
  // Usage-based cases — one row per real INSTANCE of this component
  // anywhere across the configured tabs. We replicate the same logic
  // init wrote into propsFromFigma (own componentProperties → camelCase,
  // auto-detected `label` from textOverrides[layerName], detected
  // nested-INSTANCE props from nestedProps[layer][propKey], and — when
  // the component is a container — `Pick<ChildProps>` items hydrated
  // via the child's own propsFromFigma). Master variants + usages then
  // share a single dedup pass keyed by {props, width, height}.
  // Collect per-property unique values that arrive at runtime via prop
  // spread on Generated trees. panda's static extractor doesn't recognize
  // bare object literals in cases.ts, so without help it never emits CSS
  // rules for instance-only widths/paddings/etc. Init writes these into
  // tokens/panda-runtime-values.json keyed by component, and panda.config
  // re-feeds them into staticCss to force rule generation.
  const runtimeDims: Record<string, Set<string>> = {
    width: new Set(), height: new Set(),
    paddingTop: new Set(), paddingRight: new Set(),
    paddingBottom: new Set(), paddingLeft: new Set(),
    gap: new Set(),
  }
  // "Uncovered override → detach" rule: drop instances whose figma overrides
  // include any field that no exposed prop can carry. Two sources of cover:
  //
  //   1. Per-node bindings (built below from variantRows). Each binding
  //      maps a master node id + figma field (characters/componentProperties
  //      /visible) to a prop key. Instance overrides on those (node, field)
  //      pairs flow through the prop and get re-rendered correctly.
  //
  //   2. Root-spread layout/dim fields. Generated trees forward width/
  //      height/padding/gap via `{...rest}` panda spread, so any override
  //      on the root frame's layout (including figma's primaryAxisSizingMode/
  //      counterAxisSizingMode/layoutGrow flags that toggle FIXED↔HUG) is
  //      captured by the resulting css width/height.
  //
  // NON_VISUAL fields are figma bookkeeping (exportSettings, layer renames)
  // that don't affect rendered pixels — always ignored.
  const NON_VISUAL = new Set(['exportSettings', 'autoRename', 'name', 'styledTextSegments'])
  const ROOT_LAYOUT_COVERED = new Set([
    'width', 'height', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'layoutGrow',
    // Root inst's own componentProperties (Status, leftIcon, etc.) flow
    // through propsFromFigma → raw.props mapping; always covered.
    'componentProperties',
  ])
  // (nodeId → set of figma fields covered by this node's bindings).
  // Derived directly from the same FigmaVariantMeta + detected props that
  // generateCases uses to emit Variant.bindings. Keeping the derivation
  // here (instead of reading variantRows) avoids reaching into a function-
  // local computed later in the pipeline.
  const boundFieldsByNode = new Map<string, Set<string>>()
  const addField = (nodeId: string, field: string) => {
    let s = boundFieldsByNode.get(nodeId)
    if (!s) { s = new Set(); boundFieldsByNode.set(nodeId, s) }
    s.add(field)
  }
  for (const v of normalizedMeta.variants) {
    if (detectedLabelProp && v.textNodes) {
      for (const tn of v.textNodes) {
        if (tn.name === detectedLabelProp.name) addField(tn.id, 'characters')
      }
    }
    if (v.nestedNodes) {
      for (const nn of v.nestedNodes) {
        for (const np of detectedNestedProps) {
          if (nn.name === np.layerName && (np.propKey in nn.props)) addField(nn.id, 'componentProperties')
        }
      }
    }
    if (v.visibilityNodes) {
      for (const vn of v.visibilityNodes) addField(vn.id, 'visible')
    }
  }
  const stripPrefix = (id: string) => id.includes(';') ? id.substring(id.lastIndexOf(';') + 1) : id
  let droppedUncovered = 0
  const usageRows: CaseRow[] = []
  if (scanResult) {
    const dummyRect = { x: 0, y: 0, width: 0, height: 0 }
    const ownPropKeys = Object.keys(normalizedMeta.propertyDefinitions)
    // Index containerVariations by parent id so non-container usages
    // skip the children walk (they have no container array prop).
    const containerByParentId = new Map<string, ChildVariationSample>()
    if (detectedItemsProp) {
      for (const s of scanResult.childVariations) {
        if (s.childComponentSetKey === detectedItemsProp.childComponentSetKey) {
          containerByParentId.set(s.parentId, s)
        }
      }
    }
    const droppedReasons: Record<string, number> = {}
    for (const u of scanResult.usages) {
      // Drop instances with overrides on (node, field) pairs no exposed
      // prop can carry. Per-node bindings cover specific descendants;
      // root layout fields are always covered (panda spread on Generated).
      const uncoveredFields: string[] = []
      for (const ov of (u.overrides ?? [])) {
        const bareNodeId = stripPrefix(ov.id)
        // Override on the inst itself → root-level (width/height/sizing
        // mode flags). Otherwise → descendant override; cover via per-node
        // binding map keyed by the master node id (= bareNodeId).
        const isRoot = ov.id === u.id
        const nodeBound = boundFieldsByNode.get(bareNodeId)
        for (const f of ov.fields) {
          if (NON_VISUAL.has(f)) continue
          if (isRoot && ROOT_LAYOUT_COVERED.has(f)) continue
          if (nodeBound?.has(f)) continue
          uncoveredFields.push(f)
        }
      }
      if (uncoveredFields.length > 0) {
        droppedUncovered++
        for (const f of uncoveredFields) droppedReasons[f] = (droppedReasons[f] ?? 0) + 1
        // TEMP: filter disabled for false-positive diagnostic
        // continue
      }
      const rawProps = normalizeRawProps(u.componentProperties)
      const fullProps: Record<string, unknown> = {}
      for (const name of ownPropKeys) {
        const k = propsKey(name)
        // figma componentProperties — accept any of the key forms
        // normalizeRawProps populated.
        if (k in rawProps) fullProps[k] = rawProps[k]
        else if (name in rawProps) fullProps[k] = rawProps[name]
      }
      // Synthetic `label` prop: mirrors detectedNestedProps below — must
      // live OUTSIDE the ownPropKeys loop because the synthetic key is on
      // `augmentedDefs`, not on `normalizedMeta.propertyDefinitions`.
      // Reads u.textOverrides keyed by layer name to match propsFromFigma.
      if (detectedLabelProp) {
        const v = u.textOverrides[detectedLabelProp.name]
        if (v !== undefined) fullProps.label = v
      }
      // Auto-detected nested INSTANCE props (e.g. iconType ← Icon.Type).
      for (const np of detectedNestedProps) {
        const v = u.nestedProps[np.layerName]?.[np.propKey]
        if (v !== undefined) fullProps[np.propName] = v
      }
      // Container array prop — only for parents whose children matched
      // the container shape during scan. Non-container components and
      // container parents missing from the scan leave the field unset.
      if (detectedItemsProp && childPropsFromFigma) {
        const cv = containerByParentId.get(u.id)
        if (cv) {
          const items = cv.children.map((c) => {
            const raw: FigmaInstanceRaw = {
              id: '', name: '', mainComponentName: '',
              componentSetKey: detectedItemsProp!.childComponentSetKey,
              props: normalizeRawProps(c.componentProperties) as Record<string, string | boolean>,
              exposed: [],
              textOverrides: c.textOverrides,
              nestedProps: c.nestedProps,
            }
            const node: IRComponent = {
              kind: 'component', componentSetKey: detectedItemsProp!.childComponentSetKey,
              props: {}, children: [], rect: dummyRect,
            } as unknown as IRComponent
            let hydrated: Record<string, unknown> = {}
            try { hydrated = childPropsFromFigma!(raw, node) } catch { /* skip */ }
            const picked: Record<string, unknown> = {}
            for (const k of detectedItemsProp!.varyingHydratedKeys) picked[k] = hydrated[k]
            return picked
          })
          fullProps[detectedItemsProp.propName] = items
        }
      }
      // Layout overrides: figma instances can override paddingTop/Right/
      // Bottom/Left/itemSpacing on the root frame WITHOUT detaching. Diff
      // each value vs the master variant; emit only the keys that differ
      // so impl can spread them onto the styled root for visual parity.
      // Keys map to Panda's flat props: padding* + `gap`.
      // Emit the usage's full layout (not diff vs master). impl is
      // parametric and has no implicit per-variant defaults, so missing
      // fields would render as 0/none. Once per-variant codegen bakes
      // master defaults into impl, this can drop to diff-only.
      const layoutKeys = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap'] as const
      for (const k of layoutKeys) {
        const inst = u.layout[k]
        if (inst != null) fullProps[k] = `${+(inst / 16).toFixed(6)}rem`
      }
      // Width/height override: figma `overrides` reports width/height/
      // sizingMode when designer resized the instance. Emit when actual
      // dim diverges from master so impl can lock the root box. Goes
      // through the same diff-vs-defaults pass below.
      if (u.mainWidth != null && Math.abs(u.width - u.mainWidth) > 0.5) {
        fullProps.width = `${+(u.width / 16).toFixed(6)}rem`
      }
      if (u.mainHeight != null && Math.abs(u.height - u.mainHeight) > 0.5) {
        fullProps.height = `${+(u.height / 16).toFixed(6)}rem`
      }
      // Diff against defaults — drop fields whose value matches the
      // default that defaults.ts emits + impl spreads via `{...defaults,
      // ...props}`. Keeps the per-usecase prop set minimal (the typical
      // usecase only changes label / iconType / a stretched dim).
      const slimProps: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(fullProps)) {
        const defVal = augmentedDefs[k]?.defaultValue as unknown
        if (defVal === undefined || JSON.stringify(defVal) !== JSON.stringify(v)) {
          slimProps[k] = v
        }
      }
      const lit = JSON.stringify(slimProps, null, 2).split('\n').map((l, i) => i === 0 ? l : '    ' + l).join('\n')
      // Dim-locking wrapper only for usages whose root sizing diverges
      // from the master — i.e. designer expanded/shrank the instance
      // beyond hug-content. Skipping when dim matches master keeps the
      // emitted file slim (most cases) and lets impl's natural layout drive.
      const dimOverridden =
        u.mainWidth != null && u.mainHeight != null &&
        (Math.abs(u.width - u.mainWidth) > 0.5 || Math.abs(u.height - u.mainHeight) > 0.5)
      // Use the spec's boxWrapper helper instead of inlining a raw-px div.
      // boxWrapper emits px→rem so the chromium harness's html font-size
      // supersample scales the wrapper alongside the codegen'd impl —
      // raw px would render at 1× and mismatch figma's `cfg.scale` export.
      const wrapperLiteral = dimOverridden
        ? `boxWrapper({ width: ${u.width}, height: ${u.height} })`
        : undefined
      // Stash any rem/px values for panda staticCss (see runtimeDims init above).
      for (const k of Object.keys(runtimeDims)) {
        const v = fullProps[k]
        if (typeof v === 'string' && /[0-9]/.test(v)) runtimeDims[k].add(v)
      }
      usageRows.push({
        figmaId: `${u.fileKey ?? explicitFileKey}:${u.id}`,
        // Master variant key (cross-file durable). All Variant lookups
        // happen on this — no per-file id translation needed.
        variantKey: u.mainKey ?? undefined,
        propsLiteral: lit,
        signature: stableSignature(fullProps, u.width, u.height),
        wrapperLiteral,
      })
    }
    console.log(`[init] usage-based cases: ${usageRows.length} usage(s) hydrated (pre-dedup)`)
    if (droppedUncovered > 0) {
      const breakdown = Object.entries(droppedReasons).sort((a, b) => b[1] - a[1])
        .map(([f, n]) => `${f}=${n}`).join(', ')
      console.log(`[init] dropped ${droppedUncovered} usage(s) with overrides on unexposed props (${breakdown})`)
    }
  }
  await writeFile(
    join(componentDir, 'cases.ts'),
    await fmt(generateCases(
      componentName, explicitFileKey, normalizedMeta, usageRows,
      detectedLabelProp, detectedNestedProps,
      // Map for diff-vs-default trimming. Pulled from augmentedDefs so
      // variant + usecase emit both reference the same baseline that
      // defaults.ts itself emits.
      Object.fromEntries(Object.entries(augmentedDefs).map(([k, d]) => [k, d.defaultValue])),
    )),
  )
  // panda staticCss feeder — one file per component, co-located so re-init
  // replaces just this component's slice. panda.config globs every
  // `static-tokens.json` under componentsDir and merges. Without this,
  // runtime spreads (`<Flex {...rest}>`) hit panda's static extractor as
  // bare object literals → no CSS rule emitted → Flex collapses to its
  // hardcoded master width.
  {
    const tokensPath = join(componentDir, 'static-tokens.json')
    const payload = Object.fromEntries(
      Object.entries(runtimeDims).map(([k, s]) => [k, [...s].sort()]),
    )
    await writeFile(tokensPath, JSON.stringify(payload, null, 2) + '\n')
  }
  await writeFile(
    join(componentDir, 'defaults.ts'),
    await fmt(generateDefaults(componentName, augmentedDefs)),
  )
  await writeFile(
    join(componentDir, 'index.ts'),
    await fmt(generateIndex(componentName, normalizedMeta.key, normalizedMeta.id, augmentedDefs, detectedLabelProp?.name, detectedItemsProp, detectedNestedProps)),
  )
  // master-snapshot.json — raw figma dump of each master variant. The
  // compiler reads this off disk to (a) compare instance overrides for
  // detach decisions and (b) supply variant context to the emitter
  // without going back to figma. Keyed by variant.key (cross-file
  // durable id). Skipped silently when the dumper isn't available
  // (offline scenarios — registry just falls back to empty snapshots).
  try {
    const { dump } = await import('./dumper/index.ts')
    const snapshot: Record<string, unknown> = {}
    for (const v of normalizedMeta.variants) {
      try {
        snapshot[v.key] = await dump({ cfigmaBin: cfg.cfigmaBin ?? 'cfigma', tab: tab.key, nodeId: v.id })
      } catch (e) {
        console.warn(`[init] master-snapshot dump failed for variant ${v.id} (${v.name}): ${(e as Error).message}`)
      }
    }
    await writeFile(join(componentDir, 'master-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n')
  } catch (e) {
    console.warn(`[init] master-snapshot disabled: ${(e as Error).message}`)
  }
  return {
    componentDir,
    componentName,
    variantCount: normalizedMeta.variants.length,
    variantIds: normalizedMeta.variants.map((v) => v.id),
  }
}
