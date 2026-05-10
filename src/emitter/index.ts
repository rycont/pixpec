/**
 * Emitter registry — maps the `emitter` name from `pixpec.toml` to the
 * concrete implementation. Add new targets here.
 */

import type { Emitter } from './types.ts'
import { reactPandaEmitter } from './react-panda/index.ts'

export type { Emitter, EmitContext, EmitResult, EmitterComponentMeta } from './types.ts'

const REGISTRY: Record<string, Emitter> = {
  [reactPandaEmitter.name]: reactPandaEmitter,
}

export function getEmitter(name: string): Emitter {
  const e = REGISTRY[name]
  if (!e) {
    throw new Error(
      `pixpec: unknown emitter "${name}". Available: ${Object.keys(REGISTRY).join(', ')}`,
    )
  }
  return e
}

export function listEmitters(): Emitter[] {
  return Object.values(REGISTRY)
}
