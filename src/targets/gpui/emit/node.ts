import type { DNode } from '../../../compiler/design-ast.ts'
import { FlowDirection, NodeKind } from '../../../compiler/design-ast.ts'
import type { GpuiEmitContext } from './context.ts'
import { emitContainer } from './container.ts'
import { emitImage } from './image.ts'
import { emitInstance } from './instance.ts'
import { emitShape } from './shape.ts'
import { emitText } from './text.ts'
import { emitUnknown } from './unknown.ts'
import { emitVector } from './vector.ts'

export async function emitNode(
  n: DNode,
  ctx: GpuiEmitContext,
  indent: number,
  parentDirection?: FlowDirection,
): Promise<string> {
  switch (n.kind) {
    case NodeKind.DataScope:
      return emitNode(n.child, ctx, indent, parentDirection)
    case NodeKind.Flex:
    case NodeKind.Stack:
    case NodeKind.Box:
      return emitContainer(n, ctx, indent, emitChildExpr, parentDirection)
    case NodeKind.Text:
      return emitText(n, ctx, indent)
    case NodeKind.Shape:
      return emitShape(n, ctx, indent)
    case NodeKind.Vector:
      return emitVector(n, ctx, indent)
    case NodeKind.Image:
      return emitImage(n, ctx, indent)
    case NodeKind.Instance:
      return emitInstance(n, ctx, indent)
    case NodeKind.Unknown:
      return emitUnknown(n, ctx, indent)
  }
}

export async function emitChildExpr(
  n: DNode,
  ctx: GpuiEmitContext,
  indent: number,
  parentDirection?: FlowDirection,
): Promise<string> {
  return emitNode(n, ctx, indent, parentDirection)
}
