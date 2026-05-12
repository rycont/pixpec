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
import type { RegistryEntry, NodeBindingValue } from "./registry.ts";

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
  "width",
  "height",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "layoutGrow",
  "componentProperties",
]);

export function shouldDetach(inst: RawNode, entry: RegistryEntry): boolean {
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
    const binding = entry.bindings[bareDescId];
    for (const field of ov.overriddenFields) {
      if (NON_VISUAL.has(field)) continue;
      if (isRoot && ROOT_LAYOUT_COVERED.has(field)) continue;
      if (isFieldCoveredByBinding(field, binding)) continue;
      // Check actual value equivalence vs master. masterRoot is verified
      // present above; missing per-descendant entries indicate a structural
      // figma divergence (instance has nodes that don't exist in master)
      // — treat as a real diff that triggers detach.
      const instNode = instByDescId.get(bareDescId);
      const masterNode = masterByDescId.get(bareDescId);
      if (!instNode || !masterNode) return true;
      if (fieldValueEquivalent(field, instNode, masterNode)) continue;
      return true;
    }
  }
  return false;
}

function resolveMasterRoot(
  inst: RawNode,
  entry: RegistryEntry,
): RawNode | undefined {
  const variantKey = inst.mainComponent?.key;
  if (variantKey && entry.masterSnapshot[variantKey])
    return entry.masterSnapshot[variantKey];
  const variantName = inst.mainComponent?.name;
  if (!variantName) return undefined;
  return Object.values(entry.masterSnapshot).find(
    (root) => root.name === variantName,
  );
}

function isFieldCoveredByBinding(
  field: string,
  binding?: NodeBindingValue,
): boolean {
  if (!binding) return false;
  if (field === "characters" && binding.node?.content) return true;
  if (field === "fills" && binding.node?.paint) return true;
  if (field === "textStyleId" && binding.node?.textStyle) return true;
  if (field === "visible" && binding.node?.visible) return true;
  if (
    field === "componentProperties" &&
    binding.component &&
    Object.keys(binding.component).length > 0
  )
    return true;
  return false;
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
      // VECTOR/BOOLEAN_OPERATION fills get forwarded by emitter plugins as a
      // parent CSS color (currentColor pattern — see danah's iconCurrentColor
      // plugin). The receiving component reads the parent color, so a fills
      // divergence here doesn't require detaching the instance.
      if (inst.type === "VECTOR" || inst.type === "BOOLEAN_OPERATION")
        return true;
      return paintListEquivalent(inst.fills, master.fills);
    case "strokes":
      return paintListEquivalent(inst.strokes, master.strokes);
    case "strokeWeight":
      return inst.strokeWeight === master.strokeWeight;
    case "strokeAlign":
      return inst.strokeAlign === master.strokeAlign;
    case "textStyleId":
      return textStyleEquivalent(inst, master);
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
    case "rotation":
      return (inst.rotation ?? 0) === (master.rotation ?? 0);
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
