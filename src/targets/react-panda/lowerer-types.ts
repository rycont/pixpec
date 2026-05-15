import type * as ast from "@typescript/native-preview/ast";
import type { CodegenPlugin } from "../../types.ts";
import type { DNode } from "../../compiler/design-ast.ts";
import { Sizing } from "../../compiler/design-ast.ts";
import type { CodegenContext, TargetComponentMeta } from "../types.ts";

export interface LowererCtx {
  remBase: number;
  componentName: string;
  registry: Map<string, TargetComponentMeta>;
  tokenMap: Record<string, string>;
  tokenValueMap: Record<string, number>;
  tokenColorMap: Record<string, string>;
  typographyMap: Record<string, string>;
  plugins: CodegenPlugin[];
  usedJsxPatterns: Set<string>;
  usedTypography: Set<string>;
  usedComponents: Set<string>;
  usedPropBindings: Set<string>;
  usesCss: boolean;
  outputDir?: string;
  rootDir?: string;
  componentsDir?: string;
  propsFile?: string;
  viewConfig: NonNullable<CodegenContext["viewConfig"]>;
  repetitionComponents: Array<{
    name: string;
    props: Record<string, unknown[]>;
    jsx: ast.JsxChild;
  }>;
  repetitionMarkers: Map<string, string>;
  repetitionCounter: number;
  svgSidecars: Map<
    string,
    { alias: string; content: string; importPath: string }
  >;
  imageSidecars: Map<string, { content: Uint8Array }>;
  assetUrls: Map<string, string>;
  squircleHooks: Array<{ id: number; radiusPx: number; smoothing: number }>;
  usesTinting: boolean;
  tintFilterId: string;
}

export interface ParentCtx {
  dir: "row" | "column" | "none";
  mainSizing: Sizing;
  isRoot?: boolean;
}

export interface RepetitionComponent {
  name: string;
  props: Record<string, unknown[]>;
  jsx: ast.JsxChild;
}

export const ROOT_PARENT: ParentCtx = {
  dir: "none",
  mainSizing: Sizing.Fixed,
  isRoot: true,
};

export type NodeLowerer = (
  node: DNode,
  ctx: LowererCtx,
  parent: ParentCtx,
) => ast.JsxChild;
