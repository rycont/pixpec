import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "@typescript/native-preview/sync";
import * as ast from "@typescript/native-preview/ast";
import { NodeKind } from "./design-ast.ts";

export type PropValueType =
  | "string"
  | "boolean"
  | "number"
  | "length"
  | "color"
  | "paint"
  | "shadow"
  | "textStyle";

export interface FieldTypeInfo {
  typeText: string;
  valueType: PropValueType;
}

const NODE_INTERFACE: Record<NodeKind, string> = {
  [NodeKind.DataScope]: "DDataScope",
  [NodeKind.Flex]: "DFlex",
  [NodeKind.Stack]: "DStack",
  [NodeKind.Box]: "DBox",
  [NodeKind.Text]: "DText",
  [NodeKind.Shape]: "DShape",
  [NodeKind.Vector]: "DVector",
  [NodeKind.Image]: "DImage",
  [NodeKind.Instance]: "DInstance",
  [NodeKind.Unknown]: "DUnknown",
};

export class DesignAstTypeTransformer {
  private readonly interfaces = new Map<string, Map<string, string>>();
  private readonly aliases = new Map<string, string>();

  constructor() {
    const compilerDir = dirname(fileURLToPath(import.meta.url));
    const sourcePath = resolve(compilerDir, "design-ast.ts");
    const packageRoot = resolve(compilerDir, "../..");
    const sourceText = readFileSync(sourcePath, "utf8");
    const api = new API({ cwd: packageRoot });
    try {
      const snapshot = api.updateSnapshot({
        openProject: resolve(packageRoot, "tsconfig.json"),
      });
      const project = snapshot.getProjects()[0];
      const sourceFile = project?.program.getSourceFile(sourcePath);
      if (!sourceFile) {
        throw new Error(`source file not found: ${sourcePath}`);
      }
      for (const statement of sourceFile.statements ?? []) {
        if (ast.isInterfaceDeclaration(statement)) {
          const name = statement.name?.text;
          if (!name) continue;
          const members = new Map<string, string>();
          for (const member of statement.members ?? []) {
            const property = member as { name?: { text?: string }; type?: { pos: number; end: number } };
            const memberName = property.name?.text;
            if (!memberName || !property.type) continue;
            members.set(
              memberName,
              sourceText.slice(property.type.pos, property.type.end).trim(),
            );
          }
          this.interfaces.set(name, members);
        } else if (ast.isTypeAliasDeclaration(statement)) {
          const name = statement.name?.text;
          if (!name || !statement.type) continue;
          this.aliases.set(name, sourceText.slice(statement.type.pos, statement.type.end).trim());
        }
      }
    } finally {
      api.close();
    }
  }

  fieldTypeForNode(kind: NodeKind, field: string): FieldTypeInfo {
    if (field.startsWith("component.")) {
      throw new Error(
        `pixpec init: component prop field should be typed from child schema, not DNode AST: ${field}`,
      );
    }
    const typeText = this.resolveFieldPath(NODE_INTERFACE[kind], field);
    if (!typeText) {
      throw new Error(
        `pixpec init: DNode field type not found for ${NODE_INTERFACE[kind]}.${field}`,
      );
    }
    return { typeText, valueType: this.classify(typeText) };
  }

  classify(typeText: string): PropValueType {
    const expanded = this.expandAliases(typeText);
    if (hasTypeName(expanded, "TextStyleValue") || hasTypeName(expanded, "TextStyle")) {
      return "textStyle";
    }
    if (hasTypeName(expanded, "Shadow")) {
      return "shadow";
    }
    if (hasTypeName(expanded, "Paint") || hasTypeName(expanded, "GradientPaint")) {
      return "paint";
    }
    if (hasTypeName(expanded, "Color") || hasTypeName(expanded, "ColorLiteral")) {
      return "color";
    }
    if (
      hasTypeName(expanded, "LengthValue") ||
      hasTypeName(expanded, "Length") ||
      hasTypeName(expanded, "AxisSize")
    ) {
      return "length";
    }
    if (/\bValue\s*<\s*string\s*>/.test(expanded) || /\bstring\b/.test(expanded)) {
      return "string";
    }
    if (
      hasTypeName(expanded, "TextAlign") ||
      hasTypeName(expanded, "TextDecoration") ||
      hasTypeName(expanded, "TextAutoResize")
    ) {
      return "string";
    }
    if (/\bValue\s*<\s*boolean\s*>/.test(expanded) || /\bboolean\b/.test(expanded)) {
      return "boolean";
    }
    if (/\bValue\s*<\s*number\s*>/.test(expanded) || /\bnumber\b/.test(expanded)) {
      return "number";
    }
    throw new Error(`pixpec init: unsupported DNode field type ${JSON.stringify(typeText)}`);
  }

  private resolveFieldPath(interfaceName: string, path: string): string | undefined {
    const parts = path.split(".").filter(Boolean);
    let current = this.interfaceFieldType(interfaceName, parts[0]);
    for (const part of parts.slice(1)) {
      if (!current) return undefined;
      current = this.nestedFieldType(current, part);
    }
    return current;
  }

  private interfaceFieldType(interfaceName: string, prop: string): string | undefined {
    return (
      this.interfaces.get(interfaceName)?.get(prop) ??
      this.interfaces.get("DNodeBase")?.get(prop) ??
      (interfaceName === "DStack" || interfaceName === "DBox"
        ? this.interfaces.get("DFlex")?.get(prop)
        : undefined)
    );
  }

  private nestedFieldType(typeText: string, prop: string): string | undefined {
    const objectMember = findObjectMemberType(typeText, prop);
    if (objectMember) return objectMember;
    for (const name of typeNames(typeText)) {
      const alias = this.aliases.get(name);
      if (alias) {
        const aliasMember = this.nestedFieldType(alias, prop);
        if (aliasMember) return aliasMember;
      }
      const interfaceMember = this.interfaces.get(name)?.get(prop);
      if (interfaceMember) return interfaceMember;
    }
    return undefined;
  }

  private expandAliases(typeText: string, seen = new Set<string>()): string {
    let out = typeText;
    for (const name of typeNames(typeText)) {
      if (seen.has(name)) continue;
      const alias = this.aliases.get(name);
      if (!alias) continue;
      seen.add(name);
      out += ` | ${this.expandAliases(alias, seen)}`;
    }
    return out;
  }
}

function hasTypeName(typeText: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(typeText);
}

function typeNames(typeText: string): string[] {
  return [...typeText.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)].map((match) => match[0]);
}

function findObjectMemberType(typeText: string, prop: string): string | undefined {
  for (const body of objectBodies(typeText)) {
    for (const member of splitTopLevel(body, ";")) {
      const match = member.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:\s*(.+?)\s*$/s);
      if (!match || match[1] !== prop) continue;
      return match[2].trim();
    }
  }
  return undefined;
}

function objectBodies(typeText: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < typeText.length; i += 1) {
    if (typeText[i] !== "{") continue;
    let depth = 1;
    for (let j = i + 1; j < typeText.length; j += 1) {
      if (typeText[j] === "{") depth += 1;
      else if (typeText[j] === "}") depth -= 1;
      if (depth === 0) {
        bodies.push(typeText.slice(i + 1, j));
        i = j;
        break;
      }
    }
  }
  return bodies;
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "{" || ch === "(" || ch === "<" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === ">" || ch === "]") depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
