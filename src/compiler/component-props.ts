import type { RawNode } from "../dumper/raw-node.ts";

export type ComponentPropKind = "boolean" | "string" | "variant" | "instance";

export interface ComponentPropDef {
  kind: ComponentPropKind;
  dataType: string;
  rawKey?: string;
  defaultValue?: unknown;
  variantOptions?: string[];
  field?: string;
  zodExpr?: string;
}

export function compileComponentPropDefs(
  root: RawNode,
): Record<string, ComponentPropDef> {
  const out: Record<string, ComponentPropDef> = {};
  const used = new Set<string>();
  for (const [rawKey, def] of Object.entries(root.componentPropertyDefinitions ?? {})) {
    const kind = componentPropKind(def.type);
    const key = uniquePublicPropName(rawKey, used);
    out[key] = {
      kind,
      dataType: dataTypeForKind(kind),
      rawKey,
      defaultValue: def.defaultValue,
      variantOptions: def.variantOptions,
    };
  }
  return out;
}

export function compileVariantProps(root: RawNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root.variantProperties ?? {})) {
    out[publicComponentPropName(key)] = value;
  }
  return out;
}

export function compileComponentRefDefaults(root: RawNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (node: RawNode) => {
    const refs = node.componentPropertyReferences;
    if (refs?.characters && node.type === "TEXT") out[publicComponentPropName(refs.characters)] = node.characters ?? "";
    if (refs?.visible) out[publicComponentPropName(refs.visible)] = node.visible !== false;
    if (refs?.mainComponent && node.type === "INSTANCE") {
      out[publicComponentPropName(refs.mainComponent)] = {
        kind: "instance",
        mainComponentId: node.mainComponent?.id ?? null,
        mainComponentName: node.mainComponent?.name ?? null,
      };
    }
    if (node.type === "INSTANCE") return;
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of root.children ?? []) visit(child);
  return out;
}

export function rawComponentPropValues(
  defs: Record<string, ComponentPropDef> | undefined,
  root: RawNode,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of Object.values(defs ?? {})) {
    if (def.rawKey && def.defaultValue !== undefined) out[def.rawKey] = def.defaultValue;
  }
  for (const [key, prop] of Object.entries(root.componentProperties ?? {})) {
    out[key] = prop.value;
  }
  return out;
}

export function rawComponentPropsForVariant(
  root: RawNode,
  defs: Record<string, ComponentPropDef>,
): Record<string, unknown> {
  return {
    ...rawComponentPropValues(defs, root),
    ...(root.variantProperties ?? {}),
    ...rawComponentRefValues(root),
  };
}

function rawComponentRefValues(root: RawNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (node: RawNode) => {
    const refs = node.componentPropertyReferences;
    if (refs?.characters && node.type === "TEXT") out[refs.characters] = node.characters ?? "";
    if (refs?.visible) out[refs.visible] = node.visible !== false;
    if (refs?.mainComponent && node.type === "INSTANCE") {
      out[refs.mainComponent] = {
        kind: "instance",
        mainComponentId: node.mainComponent?.id ?? null,
        mainComponentName: node.mainComponent?.name ?? null,
      };
    }
    if (node.type === "INSTANCE") return;
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of root.children ?? []) visit(child);
  return out;
}

function componentPropKind(type: string): ComponentPropKind {
  if (type === "BOOLEAN") return "boolean";
  if (type === "TEXT") return "string";
  if (type === "VARIANT") return "variant";
  if (type === "INSTANCE_SWAP") return "instance";
  return "string";
}

function dataTypeForKind(kind: ComponentPropKind): string {
  if (kind === "boolean") return "boolean";
  if (kind === "instance") return "instance";
  return "string";
}

function uniquePublicPropName(rawKey: string, used: Set<string>): string {
  const base = publicComponentPropName(rawKey) || "prop";
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base}${i++}`;
  used.add(name);
  return name;
}

function publicComponentPropName(rawKey: string): string {
  return String(rawKey).replace(/#[^#]*$/, "").replace(/\s+/g, "");
}
