import { Sizing, type DInstance } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";

export class DInstanceNode extends DNodeClass<DInstance> {
  instanceProps(): Record<string, unknown> {
    return this.node.props;
  }

  readField(field: string): unknown {
    if (field.startsWith("component.")) {
      return this.node.props[field.slice("component.".length)];
    }
    return super.readField(field);
  }

  protected visualFields(): string[] {
    const fields = [...super.visualFields(), ...Object.keys(this.node.props).map((key) => `component.${key}`)];
    if (this.node.sizing?.horizontal === Sizing.Fixed && this.node.width) fields.push("width");
    if (this.node.sizing?.vertical === Sizing.Fixed && this.node.height) fields.push("height");
    return fields;
  }
}
