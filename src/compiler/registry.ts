/**
 * Component registry for the big-bang Pixpec layout.
 *
 * A component is discovered by `<component>/pixpec.json`. Variant-local
 * parser functions live under `variants/<variant>/parser.ts`, and master IR
 * lives next to them as `ast.json`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DNode } from "./design-ast.ts";
import type { Case, CaseRenderSpec, Component, Variant } from "../types.ts";

export interface PixpecManifestVariant {
  key: string;
  name: string;
  path: string;
  figmaId: string;
  render?: CaseRenderSpec;
}

export interface PixpecManifest {
  name: string;
  figma?: {
    componentSetKey?: string | string[];
    componentSetId?: string;
  };
  variants: PixpecManifestVariant[];
}

export interface RegistryVariant {
  key: string;
  name: string;
  path: string;
  figmaId: string;
  render?: CaseRenderSpec;
  ast?: DNode;
  propsFromFigma?: (...args: unknown[]) => Record<string, unknown>;
  usecases?: Case<Record<string, unknown>>[];
}

export interface RegistryEntry {
  componentName: string;
  dir: string;
  manifest: PixpecManifest;
  variants: Record<string, RegistryVariant>;
}

export type Registry = Map<string, RegistryEntry>;

export async function loadRegistry(componentsDir: string): Promise<Registry> {
  const reg: Registry = new Map();
  if (!existsSync(componentsDir)) return reg;
  for (const ent of readdirSync(componentsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith("BD_")) continue;
    const dir = resolve(componentsDir, ent.name);
    const manifestPath = join(dir, "pixpec.json");
    if (!existsSync(manifestPath)) continue;
    const entry = await loadOne(dir, manifestPath);
    if (!entry) continue;
    for (const key of manifestKeys(entry.manifest)) reg.set(key, entry);
  }
  return reg;
}

export async function loadComponentFromPixpec(
  componentDir: string,
): Promise<Component<Record<string, unknown>>> {
  const manifest = readManifest(join(componentDir, "pixpec.json"));
  const variants: Array<Variant<Record<string, unknown>>> = [];
  for (const variant of manifest.variants) {
    const variantDir = resolve(componentDir, variant.path);
    const parser = await importFresh(resolve(variantDir, "parser.ts"));
    const usecases = readJsonIfExists<Case<Record<string, unknown>>[]>(
      resolve(variantDir, "usecases.json"),
      [],
    );
    variants.push({
      key: variant.key,
      propsSchema: parser.PropsSchema,
      propsFromFigma:
        typeof parser.propsFromFigma === "function"
          ? (parser.propsFromFigma as (...args: unknown[]) => Record<string, unknown>)
          : undefined,
      usecases,
      render: variant.render,
    });
  }
  const keys = manifestKeys(manifest);
  return {
    name: manifest.name,
    variants,
    ...(keys.length > 0
      ? {
          figma: {
            componentSetKey: keys.length === 1 ? keys[0] : keys,
            componentSetId: manifest.figma?.componentSetId,
          },
        }
      : {}),
  } as Component<Record<string, unknown>>;
}

async function loadOne(dir: string, manifestPath: string): Promise<RegistryEntry | null> {
  const manifest = readManifest(manifestPath);
  const variants: Record<string, RegistryVariant> = {};
  for (const item of manifest.variants) {
    const variantDir = resolve(dir, item.path);
    const parserPath = resolve(variantDir, "parser.ts");
    const parser = existsSync(parserPath) ? await importFresh(parserPath) : {};
    variants[item.key] = {
      key: item.key,
      name: item.name,
      path: item.path,
      figmaId: item.figmaId,
      render: item.render,
      ast: readJsonIfExists<DNode | undefined>(resolve(variantDir, "ast.json"), undefined),
      propsFromFigma:
        typeof parser.propsFromFigma === "function"
          ? (parser.propsFromFigma as (...args: unknown[]) => Record<string, unknown>)
          : undefined,
      usecases: [],
    };
  }
  return {
    componentName: manifest.name,
    dir,
    manifest,
    variants,
  };
}

export function resolveRegistryVariant(
  entry: RegistryEntry,
  key?: string,
  variantName?: string,
): RegistryVariant | undefined {
  if (key && entry.variants[key]) return entry.variants[key];
  if (!variantName) return undefined;
  return Object.values(entry.variants).find((v) => v.name === variantName);
}

function readManifest(path: string): PixpecManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PixpecManifest;
}

function readJsonIfExists<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function importFresh(path: string): Promise<Record<string, unknown>> {
  return (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)) as Record<
    string,
    unknown
  >;
}

function manifestKeys(manifest: PixpecManifest): string[] {
  const key = manifest.figma?.componentSetKey;
  if (!key) return [];
  return Array.isArray(key) ? key : [key];
}
