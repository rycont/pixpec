import type { DVector } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";

export class DVectorNode extends DNodeClass<DVector> {
  protected visualFields(): string[] {
    return [...super.visualFields(), "width", "height", "fill"];
  }
}
