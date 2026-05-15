import { TextAutoResize, type DText } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";

export class DTextNode extends DNodeClass<DText> {
  protected visualFields(): string[] {
    const fields = [...super.visualFields(), "content", "color", "textStyleRef", "textDecoration", "textAlign"];
    if (this.node.autoResize !== TextAutoResize.Hug) fields.push("width");
    return fields;
  }
}
