import type { DShape } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";

export class DShapeNode extends DNodeClass<DShape> {
  protected visualFields(): string[] {
    return [...super.visualFields(), "shape", "width", "height", "fill", "stroke.paint", "stroke.width", "cornerRadius"];
  }
}
