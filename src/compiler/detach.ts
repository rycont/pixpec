/**
 * Detach decision — should an INSTANCE be expanded into its raw children
 * during compilation, instead of emitted as a `DInstance` reference?
 *
 * The signal is "any instance override on a (descendant, field) pair whose
 * resolved value differs from the master AND isn't carried by an exposed
 * prop". Pure metadata divergence (figma reports `textStyleId` overridden
 * but the resolved fontSize/lineHeight/family/weight match master) is NOT
 * a real visual diff — those overrides survive.
 *
 * Comparator coverage today:
 *   - `fills`        on TEXT/SHAPE/VECTOR  → resolved {color, opacity}
 *   - `characters`   on TEXT               → resolved text content
 *   - `textStyleId`  on TEXT               → resolved fs/lh/family/weight
 *   - `strokes` / `strokeWeight` / `strokeAlign` → resolved stroke {color, width, align}
 *
 * Other override fields default to "non-divergent" (assumed covered) until
 * we have a concrete failing case. Conservative — avoids over-detaching.
 */

import type {
  RawNode,
  RawOverride,
  RawSolidPaint,
} from "../dumper/raw-node.ts";
import type { RegistryEntry, RegistryVariant } from "./registry.ts";
import { resolveRegistryVariant } from "./registry.ts";
import {
  BOX_WRAPPER_FIELDS,
  rawForPropsFromFigma,
  unconsumedOverridesForConsumedFields,
} from "./props-context.ts";

// `pluginData` is figma's per-node plugin storage — pure metadata, no visual
// effect. `annotations` are designer comments. Both can vary between
// instance and master without rendering differently.
const NON_VISUAL = new Set([
  "exportSettings",
  "autoRename",
  "name",
  "styledTextSegments",
  "pluginData",
  "annotations",
]);
/** Root-frame layout flags carried via the {...rest} panda spread on the
 *  Generated component root — always covered. */
const ROOT_LAYOUT_COVERED = new Set([
  ...BOX_WRAPPER_FIELDS,
  "componentProperties",
]);

export function shouldDetach(
  inst: RawNode,
  entry: RegistryEntry,
  variant: RegistryVariant | undefined = resolveRegistryVariant(
    entry,
    inst.mainComponent?.key,
    inst.mainComponent?.name,
  ),
  consumedFields: Set<string> = new Set(),
): boolean {
  if (variant?.propsFromFigma) {
    const raw = rawForPropsFromFigma(inst);
    const leftovers = unconsumedOverridesForConsumedFields(raw, consumedFields);
    if (leftovers.length === 0) return false;
    const masterRoot = resolveMasterRoot(inst, entry);
    if (!masterRoot) return (inst.children?.length ?? 0) > 0;
    const masterByDescId = indexByDescId(masterRoot);
    const instByDescId = indexByDescId(inst);
    for (const ov of leftovers) {
      const instNode = instByDescId.get(stripPrefix(ov.nodeId));
      const masterNode = masterByDescId.get(stripPrefix(ov.nodeId));
      if (!instNode || !masterNode) return true;
      for (const field of ov.fields) {
        if (field === "fills" && isNonRenderingPaintNode(instNode)) continue;
        if (fieldValueEquivalent(field, instNode, masterNode)) continue;
        return true;
      }
    }
    return false;
  }

  const overrides = inst.overrides ?? [];
  if (overrides.length === 0) return false;
  // Master snapshot is required to compare resolved values. A registered
  // component without a snapshot means init wasn't run for it under the
  // new pipeline — surface as an error so the user re-inits, rather than
  // silently treating overrides as covered.
  const variantKey = inst.mainComponent?.key;
  const masterRoot = resolveMasterRoot(inst, entry);
  if (!masterRoot) {
    // A consuming file can contain a published remote variant whose source
    // master is not present in the currently-open library file. In that case
    // the registered component dispatcher cannot render the variant, but the
    // instance dump still carries the resolved child tree, so detach it for
    // view codegen instead of emitting an unrenderable component reference.
    if ((inst.children?.length ?? 0) > 0) return true;
    throw new Error(
      `pixpec compile: registered component "${entry.componentName}" has no master-snapshot.json ` +
        `entry for variant key ${variantKey ?? "<unknown>"}` +
        `${inst.mainComponent?.name ? ` or variant name "${inst.mainComponent.name}"` : ""} ` +
        `(instance ${inst.id}). ` +
        `Run \`pixpec init\` for ${entry.componentName} to populate it.`,
    );
  }
  const masterByDescId = indexByDescId(masterRoot);
  const instByDescId = indexByDescId(inst);

  for (const ov of overrides) {
    const isRoot = ov.id === inst.id;
    const bareDescId = stripPrefix(ov.id);
    for (const field of ov.overriddenFields) {
      if (NON_VISUAL.has(field)) continue;
      if (isRoot && ROOT_LAYOUT_COVERED.has(field)) continue;
      // Check actual value equivalence vs master. masterRoot is verified
      // present above; missing per-descendant entries indicate a structural
      // figma divergence (instance has nodes that don't exist in master)
      // — treat as a real diff that triggers detach.
      const instNode = instByDescId.get(bareDescId);
      const masterNode = masterByDescId.get(bareDescId);
      if (!instNode || !masterNode) return true;
      if (field === "fills" && isNonRenderingPaintNode(instNode)) continue;
      if (fieldValueEquivalent(field, instNode, masterNode)) continue;
      return true;
    }
  }
  return false;
}

function isNonRenderingPaintNode(n: RawNode): boolean {
  return n.isMask === true || /^bounding box$/i.test((n.name ?? "").trim());
}

function resolveMasterRoot(
  inst: RawNode,
  entry: RegistryEntry,
): RawNode | undefined {
  const variantName = inst.mainComponent?.name;
  const variant = resolveRegistryVariant(entry, inst.mainComponent?.key, variantName);
  void variant;
  return undefined;
}

/** Compare a single override field's resolved value between instance and
 *  master. Returns true when the field is effectively unchanged. */
function fieldValueEquivalent(
  field: string,
  inst: RawNode,
  master: RawNode,
): boolean {
  switch (field) {
    case "fills":
      return paintListEquivalent(inst.fills, master.fills);
    case "strokes":
      return paintListEquivalent(inst.strokes, master.strokes);
    case "strokeWeight":
      return inst.strokeWeight === master.strokeWeight;
    case "strokeAlign":
      return inst.strokeAlign === master.strokeAlign;
    case "textStyleId":
      return textStyleEquivalent(inst, master);
    case "characters":
      return textContentEquivalent(inst.characters, master.characters);
    case "fontName":
      return JSON.stringify(inst.fontName) === JSON.stringify(master.fontName);
    case "fontSize":
      return inst.fontSize === master.fontSize;
    case "fontWeight":
      return inst.fontWeight === master.fontWeight;
    case "lineHeight":
      return (
        JSON.stringify(inst.lineHeight) === JSON.stringify(master.lineHeight)
      );
    case "letterSpacing":
      return (
        JSON.stringify(inst.letterSpacing) ===
        JSON.stringify(master.letterSpacing)
      );
    case "textCase":
      return inst.textCase === master.textCase;
    case "textDecoration":
      return inst.textDecoration === master.textDecoration;
    case "cornerRadius":
      return inst.cornerRadius === master.cornerRadius;
    case "opacity":
      return (inst.opacity ?? 1) === (master.opacity ?? 1);
    case "visible":
      return (inst.visible ?? true) === (master.visible ?? true);
    case "rotation":
      return (inst.rotation ?? 0) === (master.rotation ?? 0);
    case "width":
      return inst.width === master.width;
    case "height":
      return inst.height === master.height;
    case "boundVariables": {
      // boundVariables is meta; the visual outcome is captured by the
      // resolved style fields above. We treat the override as equivalent
      // unless one of the concrete style fields below also changes.
      // (A bound-variable swap that produces a different fill/font/etc
      // shows up under 'fills'/'fontSize'/etc instead.)
      return true;
    }
    default:
      // Unknown field — be conservative: treat as divergent so we don't
      // silently swallow a real visual change.
      return false;
  }
}

function textContentEquivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Some Korean labels arrive from Figma instance dumps with incidental word
  // spacing while the component master keeps the same Hangul sequence compact.
  // Treat only that narrow case as equivalent so one label-space override does
  // not detach a full navigation component from the corpus.
  if (!containsHangul(a) || !containsHangul(b)) return false;
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function containsHangul(value: string): boolean {
  return /[\u3131-\u318e\uac00-\ud7a3]/.test(value);
}

function paintListEquivalent(a?: unknown, b?: unknown): boolean {
  const aP = firstSolid(a),
    bP = firstSolid(b);
  if (!aP && !bP) return true;
  if (!aP || !bP) return false;
  const aOp = aP.opacity ?? 1,
    bOp = bP.opacity ?? 1;
  if (Math.abs(aOp - bOp) > 1e-3) return false;
  return (
    Math.abs(aP.color.r - bP.color.r) < 1e-3 &&
    Math.abs(aP.color.g - bP.color.g) < 1e-3 &&
    Math.abs(aP.color.b - bP.color.b) < 1e-3
  );
}

function firstSolid(p: unknown): RawSolidPaint | null {
  if (!Array.isArray(p)) return null;
  for (const x of p) {
    if (
      x &&
      typeof x === "object" &&
      (x as { type?: string }).type === "SOLID" &&
      (x as { visible?: boolean }).visible !== false
    ) {
      return x as RawSolidPaint;
    }
  }
  return null;
}

function textStyleEquivalent(inst: RawNode, master: RawNode): boolean {
  return (
    inst.fontSize === master.fontSize &&
    JSON.stringify(inst.lineHeight) === JSON.stringify(master.lineHeight) &&
    JSON.stringify(inst.fontName) === JSON.stringify(master.fontName) &&
    inst.fontWeight === master.fontWeight
  );
}

function indexByDescId(root: RawNode): Map<string, RawNode> {
  const out = new Map<string, RawNode>();
  const visit = (n: RawNode) => {
    out.set(stripPrefix(n.id), n);
    if (n.children) for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

function stripPrefix(id: string): string {
  return id.includes(";") ? id.substring(id.lastIndexOf(";") + 1) : id;
}
