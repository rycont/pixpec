/**
 * Mini Slint IR + indentation-aware printer. Keeps property formatting,
 * quoting, and whitespace concerns out of the per-node lowering modules.
 */

export type SExpr = string // already-formatted Slint expression text

export interface SElement {
  /** Slint element name: Window | Rectangle | HorizontalLayout | ... */
  type: string
  /** Plain `name: value;` properties, in emit order. */
  props: Array<{ name: string; value: SExpr }>
  /** Nested element children (rendered after props with one blank line). */
  children: SElement[]
}

export const elem = (type: string): SElement => ({ type, props: [], children: [] })

export const setProp = (e: SElement, name: string, value: SExpr | undefined): void => {
  if (value !== undefined) e.props.push({ name, value })
}

export const addChild = (e: SElement, child: SElement): void => {
  e.children.push(child)
}

/** Minimal Slint serialisation — no indent, no extra whitespace. The
 *  output is consumed by the slint compiler, not read by humans; debug
 *  by re-pretty-printing if needed. */
export function printElement(e: SElement): string {
  const props = e.props.map((p) => `${p.name}:${p.value};`).join('')
  const children = e.children.map((c) => printElement(c)).join('')
  return `${e.type}{${props}${children}}`
}
