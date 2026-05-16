/**
 * CompileTarget — Design AST → target-language source, plus destination
 * capture for rendered cases/views.
 *
 * Each target is a self-contained module for one destination stack
 * (React+Panda today; Slint, egui, etc. tomorrow). Pixpec selects destination
 * targets via `pixpec.toml` (`targets = ["..."]`).
 *
 * Targets share the same AST input but vary widely in:
 *   - output language (TSX / Slint / Dart / ...)
 *   - file layout (single .tsx vs split per-component)
 *   - styling system (panda atomic classes, CSS modules, native styles, ...)
 *
 * The interface keeps code generation and destination capture collocated so
 * target-specific harnesses do not leak into projects that consume Pixpec.
 */

import type { DNode } from '../compiler/design-ast.ts'

export interface CodegenContext {
  /** The component being emitted (matches the source-tree directory name). */
  componentName: string
  /** Resolved design-system metadata the target needs at render time:
   *    - tokens:     variable id → semantic path (e.g. `content.standard.primary`)
   *    - tokenColors: semantic path or variable id → resolved CSS color
   *    - typography: text-style ref → typography-component name
   *    - fonts:      font-family → font registry data (Y-shift, etc.)
   *  Each target ignores the slots it doesn't care about. */
  designSystem: {
    tokens?: Record<string, string>
    tokenValues?: Record<string, number>
    tokenColors?: Record<string, string>
    typography?: Record<string, string>
    fonts?: unknown
  }
  /** Components registered in the project (for DInstance resolution). Map
   *  keyed by componentName. Target uses this to derive import paths,
   *  prop typing, etc. */
  registry?: Map<string, TargetComponentMeta>
  /** Target-specific plugins (e.g. icon currentColor wrapper for React).
   *  Target implementations choose how to interpret these. */
  plugins?: unknown[]
  /** Design-unit → physical-unit base. Default 16 (CSS rem base). */
  remBase?: number
  /** Design-unit → target render-unit scale. Defaults to 1. */
  renderScale?: number
  /** Component-owned prop keys that must not be forwarded to the rendered root. */
  propKeys?: string[]
  /** Source figma node id for target-specific comments or sidecar ids. */
  sourceId?: string
  /** Directory where the emitted source file will be written. Import paths are
   *  computed relative to this directory when present. */
  outputDir?: string
  /** Project root. Defaults to process.cwd(); used to resolve styled-system. */
  rootDir?: string
  /** Components directory. Defaults to <rootDir>/src/components. */
  componentsDir?: string
  /** Optional props file for component output. Omit for prop-less view output. */
  propsFile?: string
  /** Directory where compile-side shared assets (SVG bytes, image bytes) are
   *  persisted. Lowerers read source content from here and build import paths
   *  relative to `outputDir`. */
  assetsDir?: string
  /** Optional view-level semantic transforms, loaded from src/view/<View>/view.config.json. */
  viewConfig?: ViewCodegenConfig
}

export interface ViewCodegenConfig {
  [sourceId: string]: {
    repetition: {
      childComponent: { name: string }
    }
  }
}

/** Minimal component metadata a target needs about a registered DInstance
 *  target. Targets may extend with target-specific extra fields. */
export interface TargetComponentMeta {
  componentName: string
  /** Absolute path to the component's source directory. Used to compute
   *  relative import paths from the generated file. */
  dir: string
  /** Whether the component takes any props (controls call-site shape). */
  hasProps?: boolean
}

export interface CodegenResult {
  /** Generated source file content. */
  source: string
  /** File extension to write (without dot) — `tsx`, `slint`, `dart`, ... */
  fileExtension: string
  /** Optional sidecar files a target wants to drop next to the main output
   *  (e.g. target-specific config, a CSS module, etc.). */
  sidecars?: Array<{ relativePath: string; content: string | Uint8Array }>
}

export type CaptureKind = 'case' | 'view'

export interface CaptureRequest {
  kind: CaptureKind
  ids: string[]
}

export interface CaptureArtifact {
  id: string
  pngPath: string
}

export interface CaptureResult {
  artifacts: CaptureArtifact[]
}

export interface CompileTarget {
  /** Stable identifier referenced from `pixpec.toml`. */
  name: string
  /** Human-readable description for CLI listings. */
  description?: string
  /** Compile a single Design AST root to the target source. */
  codegen(root: DNode, ctx: CodegenContext): CodegenResult | Promise<CodegenResult>
  /** Capture rendered destination artifacts for cases or views. */
  capture(request: CaptureRequest): Promise<CaptureResult>
}
