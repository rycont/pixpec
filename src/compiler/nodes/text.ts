import { TextAutoResize, type DText } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";

export class DTextNode extends DNodeClass<DText> {
  protected visualFields(): string[] {
    const fields = [
      ...super.visualFields(),
      "content",
      "fontFamily",
      "fontWeight",
      "fontSize",
      "lineHeight",
      "color",
      "textDecoration",
      "textAlign",
    ];
    if (this.node.autoResize !== TextAutoResize.Hug) fields.push("width");
    return fields;
  }
}
