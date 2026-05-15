import type { DDataScope, DNode } from "../design-ast.ts";
import { DNodeClass } from "./base.ts";

export class DDataScopeNode extends DNodeClass<DDataScope> {
  constructor(
    node: DDataScope,
    private readonly childClass: DNodeClass,
  ) {
    super(node);
  }

  children(): DNodeClass[] {
    return [this.childClass];
  }

  toJSON(): DDataScope {
    return {
      ...this.node,
      child: this.childClass.toJSON(),
    };
  }
}
