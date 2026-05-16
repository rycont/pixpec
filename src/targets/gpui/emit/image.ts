import type { DImage } from "../../../compiler/design-ast.ts";
import { div, image } from "./chain.ts";
import type { GpuiEmitContext } from "./context.ts";
import { addNodeLayout } from "./layout.ts";
import { lengthExpr } from "./values.ts";

export function emitImage(
  n: DImage,
  ctx: GpuiEmitContext,
  indent: number,
): string {
  if (!n.asset) {
    const chain = div(indent)
      .method("w", lengthExpr(n.width, ctx))
      .method("h", lengthExpr(n.height, ctx));
    addNodeLayout(chain, n, ctx);
    return chain.toString();
  }

  const chain = image(indent, n.asset)
    .method("w", lengthExpr(n.width, ctx))
    .method("h", lengthExpr(n.height, ctx))
    .method("object_fit", "ObjectFit::Fill");
  addNodeLayout(chain, n, ctx);
  return chain.toString();
}
