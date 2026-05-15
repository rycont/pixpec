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
    if (this.node.width && this.node.width !== Sizing.Fill && this.node.width !== Sizing.Hug) fields.push("width");
    if (this.node.height && this.node.height !== Sizing.Fill && this.node.height !== Sizing.Hug) fields.push("height");
    return fields;
  }
}
