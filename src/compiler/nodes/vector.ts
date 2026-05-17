import type { DVector } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";

export class DVectorNode extends DNodeClass<DVector> {
  protected visualFields(): string[] {
    return [
      ...super.visualFields(),
      "width",
      "height",
      "fill",
      "absolute.horizontal.start",
      "absolute.horizontal.end",
      "absolute.horizontal.delta",
      "absolute.vertical.start",
      "absolute.vertical.end",
      "absolute.vertical.delta",
    ];
  }
}
