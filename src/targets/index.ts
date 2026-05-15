/** Compile target registry. Add Slint/egui targets here. */

import type { CompileTarget } from './types.ts'
import { reactPandaTarget } from './react-panda/index.ts'

export type {
  CompileTarget,
  CodegenContext,
  CodegenResult,
  CaptureArtifact,
  CaptureKind,
  CaptureRequest,
  CaptureResult,
  TargetComponentMeta,
} from './types.ts'

const REGISTRY: Record<string, CompileTarget> = {
  [reactPandaTarget.name]: reactPandaTarget,
}

export function getTarget(name: string): CompileTarget {
  const target = REGISTRY[name]
  if (!target) {
    throw new Error(
      `pixpec: unknown target "${name}". Available: ${Object.keys(REGISTRY).join(', ')}`,
    )
  }
  return target
}

export function listTargets(): CompileTarget[] {
  return Object.values(REGISTRY)
}

export function resolveConfiguredTargets(cfg: { targets: string[] }): string[] {
  if (!Array.isArray(cfg.targets) || cfg.targets.length === 0) {
    throw new Error('pixpec: pixpec.toml must define targets = ["..."]')
  }
  for (const name of cfg.targets) getTarget(name)
  return cfg.targets
}

export function resolveOneConfiguredTarget(
  cfg: { targets: string[] },
  target?: string,
): string {
  if (target) {
    getTarget(target)
    return target
  }
  const targets = resolveConfiguredTargets(cfg)
  if (targets.length !== 1) {
    throw new Error(
      `pixpec: this command needs --target because pixpec.toml defines multiple targets: ${targets.join(', ')}`,
    )
  }
  return targets[0]!
}
