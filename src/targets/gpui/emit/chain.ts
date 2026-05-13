import { pad } from './rust.ts'
import { str } from './rust.ts'

export class GpuiChain {
  private readonly calls: string[] = []
  private readonly styleAssignments: string[] = []

  constructor(
    private readonly base: string,
    private readonly indent: number,
  ) {}

  method(name: string, arg?: string): this {
    this.calls.push(arg === undefined ? `.${name}()` : `.${name}(${arg})`)
    return this
  }

  child(expr: string): this {
    return this.method('child', expr.includes('\n') ? expr : expr.trim())
  }

  styleAssign(field: string, value: string): this {
    this.styleAssignments.push(`node.style().${field} = ${value};`)
    return this
  }

  toString(): string {
    const innerIndent = this.styleAssignments.length ? this.indent + 1 : this.indent
    const lines = this.styleAssignments.length
      ? [`${pad(this.indent)}{`, `${pad(innerIndent)}let mut node = ${this.base}`]
      : [`${pad(this.indent)}${this.base}`]
    for (const call of this.calls) {
      const open = call.indexOf('(')
      const arg = call.slice(open + 1, -1)
      if (arg.includes('\n')) {
        lines.push(`${pad(innerIndent + 1)}${call.slice(0, open + 1)}`)
        lines.push(arg)
        lines.push(`${pad(innerIndent + 1)})`)
      } else {
        lines.push(`${pad(innerIndent + 1)}${call}`)
      }
    }
    if (this.styleAssignments.length) {
      lines[lines.length - 1] += ';'
      for (const assignment of this.styleAssignments) {
        lines.push(`${pad(innerIndent)}${assignment}`)
      }
      lines.push(`${pad(innerIndent)}node`)
      lines.push(`${pad(this.indent)}}`)
    }
    return lines.join('\n')
  }
}

export function div(indent: number): GpuiChain {
  return new GpuiChain('div()', indent)
}

export function image(indent: number, path: string): GpuiChain {
  return new GpuiChain(`img(${str(path)})`, indent)
}
