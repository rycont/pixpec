import { NodeKind, type DNode } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";
import { DBoxNode, DFlexNode, DStackNode } from "./container.ts";
import { DDataScopeNode } from "./data-scope.ts";
import { DImageNode } from "./image.ts";
import { DInstanceNode } from "./instance.ts";
import { DShapeNode } from "./shape.ts";
import { DTextNode } from "./text.ts";
import { DUnknownNode } from "./unknown.ts";
import { DVectorNode } from "./vector.ts";

export function materializeDNode(node: DNode): DNodeClass {
  switch (node.kind) {
    case NodeKind.DataScope:
      return new DDataScopeNode(node, materializeDNode(node.child));
    case NodeKind.Flex:
      return new DFlexNode(node, node.children.map(materializeDNode));
    case NodeKind.Stack:
      return new DStackNode(node, node.children.map(materializeDNode));
    case NodeKind.Box:
      return new DBoxNode(node, node.children.map(materializeDNode));
    case NodeKind.Text:
      return new DTextNode(node);
    case NodeKind.Shape:
      return new DShapeNode(node);
    case NodeKind.Vector:
      return new DVectorNode(node);
    case NodeKind.Image:
      return new DImageNode(node);
    case NodeKind.Instance:
      return new DInstanceNode(node);
    case NodeKind.Unknown:
      return new DUnknownNode(node);
  }
}

export function materializeDNodes(nodes: DNode[]): DNodeClass[] {
  return nodes.map(materializeDNode);
}
