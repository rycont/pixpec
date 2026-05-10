/**
 * Emitter — Design AST → target-language source.
 *
 * Each emitter is a self-contained module that knows how to render the
 * Design AST to a particular framework (React+Panda today; Slint, Flutter,
 * SwiftUI, etc. tomorrow). The pixpec pipeline picks one emitter per build,
 * configured via `pixpec.toml` (`emitter = "react-panda"`).
 *
 * Emitters share the same AST input but vary widely in:
 *   - output language (TSX / Slint / Dart / ...)
 *   - file layout (single .tsx vs split per-component)
 *   - styling system (panda atomic classes, CSS modules, native styles, ...)
 *
 * The interface stays minimal so each target can shape its own output
 * conventions without forcing a lowest-common-denominator API.
 */

import type { DNode } from '../compiler/design-ast.ts'

export interface EmitContext {
  /** The component being emitted (matches the source-tree directory name). */
  componentName: string
  /** Resolved design-system metadata the emitter needs at render time:
   *    - tokens:     variable id → semantic path (e.g. `content.standard.primary`)
   *    - typography: text-style ref → typography-component name
   *    - fonts:      font-family → font registry data (Y-shift, etc.)
   *  Each emitter ignores the slots it doesn't care about. */
  designSystem: {
    tokens?: Record<string, string>
    typography?: Record<string, string>
    fonts?: unknown
  }
  /** Components registered in the project (for DInstance resolution). Map
   *  keyed by componentName. Emitter uses this to derive import paths,
   *  prop typing, etc. */
  registry?: Map<string, EmitterComponentMeta>
  /** Emitter-specific plugins (e.g. icon currentColor wrapper for React).
   *  Emitter implementations choose how to interpret these. */
  plugins?: unknown[]
  /** Design-unit → physical-unit base. Default 16 (CSS rem base). */
  remBase?: number
}

/** Minimal component metadata an emitter needs about a registered DInstance
 *  target. Emitters may extend with target-specific extra fields. */
export interface EmitterComponentMeta {
  componentName: string
  /** Absolute path to the component's source directory. Used to compute
   *  relative import paths from the generated file. */
  dir: string
  /** Whether the component takes any props (controls call-site shape). */
  hasProps?: boolean
}

export interface EmitResult {
  /** Generated source file content. */
  source: string
  /** File extension to write (without dot) — `tsx`, `slint`, `dart`, ... */
  fileExtension: string
  /** Optional sidecar files an emitter wants to drop next to the main
   *  output (e.g. emitter-specific config, a CSS module, etc.). */
  sidecars?: Array<{ relativePath: string; content: string }>
}

export interface Emitter {
  /** Stable identifier referenced from `pixpec.toml`. */
  name: string
  /** Human-readable description for CLI listings. */
  description?: string
  /** Compile a single Design AST root to the target source. */
  emit(root: DNode, ctx: EmitContext): EmitResult | Promise<EmitResult>
}
