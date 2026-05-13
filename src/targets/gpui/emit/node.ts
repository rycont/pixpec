import type { DNode } from '../../../compiler/design-ast.ts'
import { NodeKind } from '../../../compiler/design-ast.ts'
import type { GpuiEmitContext } from './context.ts'
import { emitContainer } from './container.ts'
import { emitImage } from './image.ts'
import { emitInstance } from './instance.ts'
import { pad } from './rust.ts'
import { emitShape } from './shape.ts'
import { emitText } from './text.ts'
import { emitUnknown } from './unknown.ts'
import { emitVector } from './vector.ts'

export async function emitNode(n: DNode, ctx: GpuiEmitContext, indent: number): Promise<string> {
  switch (n.kind) {
    case NodeKind.Flex:
    case NodeKind.Stack:
    case NodeKind.Box:
      return emitContainer(n, ctx, indent, emitChildExpr)
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

export async function emitChildExpr(n: DNode, ctx: GpuiEmitContext, indent: number): Promise<string> {
  if (!n.visibilityBinding) return emitNode(n, ctx, indent)

  return [
    `${pad(indent)}if true {`,
    await emitNode(n, ctx, indent + 1),
    `${pad(indent)}} else {`,
    `${pad(indent + 1)}div()`,
    `${pad(indent)}}`,
  ].join('\n')
}
