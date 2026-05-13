import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ViewCodegenConfig } from './targets/types.ts'

export async function loadViewCodegenConfig(viewDir: string): Promise<ViewCodegenConfig | undefined> {
  const path = resolve(viewDir, 'view.config.json')
  if (!existsSync(path)) return undefined
  const raw = await readFile(path, 'utf8')
  return normalizeViewCodegenConfig(JSON.parse(raw))
}

export function normalizeViewCodegenConfig(value: unknown): ViewCodegenConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pixpec view.config.json: expected an object keyed by source node id')
  }
  const out: ViewCodegenConfig = {}
  for (const [sourceId, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error(`pixpec view.config.json: entry ${sourceId} must be an object`)
    }
    const entry = rawEntry as { repetition?: unknown }
    if (!entry.repetition) continue
    if (typeof entry.repetition !== 'object' || Array.isArray(entry.repetition)) {
      throw new Error(`pixpec view.config.json: entry ${sourceId}.repetition must be an object`)
    }
    const repetition = entry.repetition as {
      childComponent?: { name?: unknown }
    }
    const name = typeof repetition.childComponent?.name === 'string'
      ? repetition.childComponent.name
      : undefined
    if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(
        `pixpec view.config.json: entry ${sourceId}.repetition.childComponent.name must be a valid component identifier`,
      )
    }
    out[sourceId] = { repetition: { childComponent: { name } } }
  }
  return out
}
