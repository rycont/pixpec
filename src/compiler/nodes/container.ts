import { Sizing, type DBox, type DFlex, type DNode, type DStack } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";

abstract class DContainerNode<T extends DFlex | DStack | DBox> extends DNodeClass<T> {
  constructor(
    node: T,
    private readonly childClasses: DNodeClass[] = [],
  ) {
    super(node);
  }

  children(): DNodeClass[] {
    return this.childClasses;
  }

  toJSON(): T {
    return {
      ...this.node,
      children: this.childClasses.map((child) => child.toJSON()),
    } as T;
  }

  protected visualFields(): string[] {
    const fields = [
      ...super.visualFields(),
      "background",
      "border.paint",
      "border.width",
      "shadow",
      "cornerRadius",
      "cornerSmoothing",
      "clip",
    ];
    if (this.node.padding) fields.push("padding");
    if ("gap" in this.node && this.node.gap) fields.push("gap");
    if ("counterGap" in this.node && this.node.counterGap) fields.push("counterGap");
    if (this.node.width && this.node.width !== Sizing.Fill && this.node.width !== Sizing.Hug) fields.push("width");
    if (this.node.height && this.node.height !== Sizing.Fill && this.node.height !== Sizing.Hug) fields.push("height");
    return fields;
  }
}

export class DFlexNode extends DContainerNode<DFlex> {}
export class DStackNode extends DContainerNode<DStack> {}
export class DBoxNode extends DContainerNode<DBox> {}
