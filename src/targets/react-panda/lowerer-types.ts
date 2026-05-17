import type * as ast from '@typescript/native-preview/ast'
import type { DNode } from '../../compiler/design-ast.ts'
import type { CodegenContext, TargetComponentMeta } from '../types.ts'

// Read-only build environment. Lowerers may read but must not mutate.
export interface Env {
    readonly remBase: number
    readonly registry: Map<string, TargetComponentMeta>
    readonly tokenMap: Record<string, string>
    readonly typographyMap: Record<string, string>
    readonly outputDir?: string
    readonly rootDir?: string
    readonly componentsDir?: string
    readonly propsFile?: string
    /** Directory where compile-written assets (SVG, image bytes) live.
     *  Lowerers read source content from here when they need to derive
     *  metadata (e.g. SVG dimensions) or produce target-specific sidecar
     *  variants (e.g. tinted SVG). */
    readonly assetsDir?: string
    readonly viewConfig: NonNullable<CodegenContext['viewConfig']>
}

// Bottom-up accumulator. Each lowerer starts with `emptyUses()`, merges its
// children's, and adds its own. Squircle hooks are keyed by node sourceId so
// the final numeric id can be assigned post-merge in buildSource.
export interface Uses {
    usedJsxPatterns: Set<string>
    usedTypography: Set<string>
    usedComponents: Set<string>
    usesCss: boolean
    /** ESM default imports: alias → import specifier path.
     *  Used for SVG (`?react`), raster image (bg URLs), etc. */
    defaultImports: Map<string, string>
    /** Sidecar files to write next to the generated source.
     *  Key is the path relative to the generated file. */
    sidecarFiles: Map<string, string | Uint8Array>
    squircleHooks: Array<{ key: string; radiusPx: number; smoothing: number }>
    usesTinting: boolean
    tintFilterId: string
}

export interface LowererCtx {
    readonly env: Env
}

export interface LowerResult {
    jsx: ast.JsxChild
    uses: Uses
}

// Parent-supplied context flags. A child cannot reference its parent object;
// it only sees the flags the parent chose to grant. Invariants (e.g. Flex/Stack
// are mutually exclusive) are upheld by the factory functions below — do not
// construct a ParentCtx directly outside this module.
export enum LocalCtx {
    Root, // direct child of the top-level component scaffold
    Flex, // parent lays out children on the row main axis
    Stack, // parent lays out children on the column main axis
    // No Flex and no Stack → parent is Box (no auto-layout).
    MainAxisHug, // parent's main axis is Hug-sized (vs Fixed/Fill)
}

export type ParentCtx = ReadonlySet<LocalCtx>

export function flexCtx(opts: { mainAxisHug: boolean }): ParentCtx {
    const s = new Set<LocalCtx>([LocalCtx.Flex])
    if (opts.mainAxisHug) {
        s.add(LocalCtx.MainAxisHug)
    }
    return s
}

export function stackCtx(opts: { mainAxisHug: boolean }): ParentCtx {
    const s = new Set<LocalCtx>([LocalCtx.Stack])
    if (opts.mainAxisHug) {
        s.add(LocalCtx.MainAxisHug)
    }
    return s
}

export function boxCtx(): ParentCtx {
    return new Set()
}

export const ROOT_PARENT: ParentCtx = new Set([LocalCtx.Root])

export type NodeLowerer = (node: DNode, ctx: LowererCtx, parent: ParentCtx) => LowerResult

export function emptyUses(): Uses {
    return {
        usedJsxPatterns: new Set(),
        usedTypography: new Set(),
        usedComponents: new Set(),
        usesCss: false,
        defaultImports: new Map(),
        sidecarFiles: new Map(),
        squircleHooks: [],
        usesTinting: false,
        tintFilterId: '',
    }
}

export function mergeUses(into: Uses, ...froms: Uses[]): void {
    for (const from of froms) {
        for (const v of from.usedJsxPatterns) {
            into.usedJsxPatterns.add(v)
        }
        for (const v of from.usedTypography) {
            into.usedTypography.add(v)
        }
        for (const v of from.usedComponents) {
            into.usedComponents.add(v)
        }
        if (from.usesCss) {
            into.usesCss = true
        }
        for (const [k, v] of from.defaultImports) {
            into.defaultImports.set(k, v)
        }
        for (const [k, v] of from.sidecarFiles) {
            into.sidecarFiles.set(k, v)
        }
        into.squircleHooks.push(...from.squircleHooks)
        if (from.usesTinting) {
            into.usesTinting = true
        }
        if (from.tintFilterId && !into.tintFilterId) {
            into.tintFilterId = from.tintFilterId
        }
    }
}
