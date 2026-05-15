import type { DImage } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";

export class DImageNode extends DNodeClass<DImage> {
  protected visualFields(): string[] {
    return [...super.visualFields(), "width", "height", "dataUrl", "renderedDataUrl", "imageScaleMode", "imageTransform"];
  }
}
