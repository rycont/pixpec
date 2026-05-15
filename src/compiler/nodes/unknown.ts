import type { DUnknown } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";

export class DUnknownNode extends DNodeClass<DUnknown> {
  protected visualFields(): string[] {
    return [...super.visualFields(), "hidden", "width", "height"];
  }
}
