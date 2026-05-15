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
      if (stableJson(before) === stableJson(after)) continue;
      diffs.push({ field, before, after });
    }
    return diffs;
  }

  toJSON(): T {
    return this.node;
  }

  protected visualFields(): string[] {
    return ["visible"];
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
