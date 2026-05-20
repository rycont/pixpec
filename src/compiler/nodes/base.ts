import type { DNode } from "../design-ast.ts";

export interface VisualDiff {
  field: string;
  before: unknown;
  after: unknown;
}

export abstract class DNodeClass<T extends DNode = DNode> {
  constructor(readonly node: T) {}

  get kind(): T["kind"] {
    return this.node.kind;
  }

  get sourceId(): string | undefined {
    return this.node.sourceId;
  }

  get sourceName(): string | undefined {
    return this.node.sourceName;
  }

  children(): DNodeClass[] {
    return [];
  }

  readField(field: string): unknown {
    return readPath(this.node as unknown as Record<string, unknown>, field);
  }

  instanceProps(): Record<string, unknown> | undefined {
    return undefined;
  }

  visualDiff(other: DNodeClass): VisualDiff[] {
    if (this.kind !== other.kind) {
      return [{ field: "kind", before: this.kind, after: other.kind }];
    }
    const diffs: VisualDiff[] = [];
    for (const field of this.visualFields()) {
      const before = this.readField(field);
      const after = other.readField(field);
      if (isExpressionValue(before) || isExpressionValue(after)) continue;
      if (equivalentValue(before, after)) continue;
      diffs.push({ field, before, after });
    }
    return diffs;
  }

  toJSON(): T {
    return this.node;
  }

  protected visualFields(): string[] {
    return ["hidden"];
  }
}

export function indexDNodeClasses(roots: DNodeClass[]): Map<string, DNodeClass> {
  const out = new Map<string, DNodeClass>();
  const visit = (node: DNodeClass) => {
    if (node.sourceId) out.set(stripPrefix(node.sourceId), node);
    for (const child of node.children()) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isExpressionValue(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "expression";
}

function equivalentValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 0.01;
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return stableJson(a) === stableJson(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => equivalentValue(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => {
    return key === bKeys[index] && equivalentValue(aRecord[key], bRecord[key]);
  });
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function stripPrefix(id: string): string {
  return id.startsWith("I") ? id.slice(1) : id;
}
