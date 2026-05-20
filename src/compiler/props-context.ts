import type {
  FigmaInstanceRaw,
  FigmaOverride,
} from "../types.ts";
import type { RawNode, RawOverride } from "../dumper/raw-node.ts";

type ConsumedFieldSource = {
  prop: string;
  kind: "field";
  nodeId: string;
  field: string;
};

const NON_COMPONENT_FIELDS = new Set([
  "exportSettings",
  "autoRename",
  "name",
  "styledTextSegments",
  "pluginData",
  "annotations",
]);

export const BOX_WRAPPER_FIELDS = new Set([
  "width",
  "height",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "layoutGrow",
  "layoutPositioning",
]);

export function isBoxWrapperField(field: string): boolean {
  return BOX_WRAPPER_FIELDS.has(field);
}

export function stripNodePrefix(id: string): string {
  return id.includes(";") ? id.substring(id.lastIndexOf(";") + 1) : id;
}

export function normalizeInstanceOverrides(
  raw: FigmaInstanceRaw,
  rootNodeId: string,
  rawOverrides: Array<RawOverride | { id: string; fields: string[] }> = [],
): FigmaOverride[] {
  const out: FigmaOverride[] = [];
  const bareRootNodeId = stripNodePrefix(rootNodeId);
  for (const ov of rawOverrides) {
    const id = ov.id;
    const fields =
      "overriddenFields" in ov ? ov.overriddenFields : ov.fields;
    const bareNodeId = stripNodePrefix(id);
    const isRoot = id === rootNodeId || bareNodeId === bareRootNodeId;
    const kept = fields.filter((field) => {
      if (NON_COMPONENT_FIELDS.has(field)) return false;
      if (isRoot && field === "componentProperties") return false;
      if (isRoot && BOX_WRAPPER_FIELDS.has(field)) return false;
      return true;
    });
    if (kept.length > 0) {
      out.push({ nodeId: bareNodeId, fields: [...new Set(kept)] });
    }
  }
  return out;
}

export function rawForPropsFromFigma(node: RawNode): FigmaInstanceRaw {
  const setKey = node.mainComponent?.parentKey ?? node.mainComponent?.key ?? "";
  const raw: FigmaInstanceRaw = {
    id: node.id,
    name: node.name,
    mainComponentName: node.mainComponent?.name ?? "",
    componentSetKey: setKey,
    props: extractPropsRecord(node.componentProperties),
    exposed: (node.exposedInstances ?? []).map((i) => ({
      name: i.name,
      mainComponentName: "",
      props: {},
    })),
    textOverrides: collectTextOverrides(node),
    nestedProps: collectNestedInstanceProps(node),
  };
  raw.overrides = normalizeInstanceOverrides(raw, node.id, node.overrides ?? []);
  return raw;
}

export function rawOverrideFieldForDNodeField(field: string): string {
  if (field === "content") return "characters";
  if (field === "color" || field === "fill" || field === "background")
    return "fills";
  if (field === "border.paint") return "strokes";
  if (field === "textStyleRef") return "textStyleId";
  if (field === "hidden") return "visible";
  if (field.startsWith("component.")) return "componentProperties";
  return field;
}

export function unconsumedOverridesForConsumedFields(
  raw: FigmaInstanceRaw,
  consumedFields: Set<string>,
): FigmaOverride[] {
  const consumed = new Set<string>();
  for (const item of consumedFields) {
    const [nodeId, field] = item.split("\0");
    if (!nodeId || !field) continue;
    consumed.add(`${stripNodePrefix(nodeId)}\0${rawOverrideFieldForDNodeField(field)}`);
  }

  const leftovers: FigmaOverride[] = [];
  for (const ov of raw.overrides ?? []) {
    const fields = ov.fields.filter(
      (field) => !consumed.has(`${stripNodePrefix(ov.nodeId)}\0${field}`),
    );
    if (fields.length > 0) leftovers.push({ nodeId: ov.nodeId, fields });
  }
  return leftovers;
}

export function unconsumedOverridesForSources(
  raw: FigmaInstanceRaw,
  props: Record<string, unknown>,
  sources: ConsumedFieldSource[],
): FigmaOverride[] {
  const consumed = new Set<string>();
  const key = (nodeId: string, field: string) => `${stripNodePrefix(nodeId)}\0${field}`;
  const consume = (nodeId: string, field: string) => {
    consumed.add(key(nodeId, field));
  };

  for (const source of sources) {
    if (!(source.prop in props)) continue;
    consume(source.nodeId, rawOverrideFieldForDNodeField(source.field));
  }

  const leftovers: FigmaOverride[] = [];
  for (const ov of raw.overrides ?? []) {
    const fields = ov.fields.filter(
      (field) => !consumed.has(key(ov.nodeId, field)),
    );
    if (fields.length > 0) leftovers.push({ nodeId: ov.nodeId, fields });
  }
  return leftovers;
}

function extractPropsRecord(
  cp?: RawNode["componentProperties"],
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (!cp) return out;
  for (const [k, v] of Object.entries(cp)) {
    if (typeof v.value === "boolean" || typeof v.value === "string") {
      addPropKeyAliases(out, k, v.value);
    }
  }
  return out;
}

function addPropKeyAliases(
  out: Record<string, string | boolean>,
  rawKey: string,
  value: string | boolean,
) {
  const short = rawKey.split("#")[0];
  const normalized = propAlias(short);
  for (const key of [rawKey, short, normalized]) {
    if (key && !(key in out)) out[key] = value;
  }
}

function propAlias(value: string): string {
  const parts = value
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return value;
  return parts.map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

function collectTextOverrides(n: RawNode): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (node: RawNode, ownerId: string) => {
    if (node.type === "INSTANCE" && node.id !== ownerId) return;
    if (node.type === "TEXT" && typeof node.characters === "string")
      out[node.name] = node.characters;
    if (node.children) for (const c of node.children) visit(c, ownerId);
  };
  if (n.children) for (const c of n.children) visit(c, n.id);
  return out;
}

function collectNestedInstanceProps(
  n: RawNode,
): Record<string, Record<string, string | boolean>> {
  const out: Record<string, Record<string, string | boolean>> = {};
  const visit = (node: RawNode, ownerId: string) => {
    if (node.type === "INSTANCE" && node.id !== ownerId) {
      out[node.name] = extractPropsRecord(node.componentProperties);
      return;
    }
    if (node.children) for (const c of node.children) visit(c, ownerId);
  };
  if (n.children) for (const c of n.children) visit(c, n.id);
  return out;
}
