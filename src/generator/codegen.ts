/**
 * IR → React + PandaCSS JSX codegen.
 *
 * Conservative starting strategy:
 *   - IRComponent → <Name {...props} />
 *   - IRFrame → <div className={css({...})}>{children}</div>
 *   - IRText → <span style={{fontSize, lineHeight, fontWeight, color}}>content</span>
 *   - IRVector / IRUnknown → <div style={{width,height,bg:'red'}} />  (placeholder)
 *
 * Phase 0 doesn't try to map figma colors → panda tokens — emits hex
 * literals. Token mapping is Phase 4.
 */
import type { Component } from '../types.ts'
import type { IRNode, IRComponent, IRFrame, IRText, IRVector, IRUnknown } from './ir.ts'

interface IRComponentRaw extends IRComponent {
  raw: unknown  // emitted by walker before fromInstance() applied
}

/**
 * Apply each registered component's fromInstance to IRComponentRaw nodes
 * to fill in their .props field. Mutates the tree.
 */
export function hydrate(node: IRNode, components: Component<unknown>[]): IRNode {
  if (node.kind === 'component') {
    const c = node as IRComponentRaw
    const comp = components.find((x) => x.name === c.componentName)
    if (comp?.figma) c.props = comp.figma.fromInstance(c.raw as never) as Record<string, unknown>
    delete (c as Partial<IRComponentRaw>).raw
  }
  if (node.kind === 'frame') {
    for (const child of node.children) hydrate(child, components)
  }
  return node
}

const indent = (depth: number) => '  '.repeat(depth)

function emit(node: IRNode, depth: number): string {
  const pad = indent(depth)
  switch (node.kind) {
    case 'component':
      return emitComponent(node, pad)
    case 'frame':
      return emitFrame(node, depth)
    case 'text':
      return emitText(node, pad)
    case 'vector':
      return emitVector(node, pad)
    case 'unknown':
      return emitUnknown(node, pad)
  }
}

function emitComponent(n: IRComponent, pad: string): string {
  // Split props into JSX-safe (identifier names) and rest (spaces, etc → spread).
  const safe: string[] = []
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(n.props)) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) {
      safe.push(`${k}={${JSON.stringify(v)}}`)
    } else {
      rest[k] = v
    }
  }
  const restStr = Object.keys(rest).length ? ` {...${JSON.stringify(rest)}}` : ''
  return `${pad}<${n.componentName}${safe.length ? ' ' + safe.join(' ') : ''}${restStr} />`
}

function emitFrame(n: IRFrame, depth: number): string {
  const pad = indent(depth)
  const flexDir = n.layout.direction === 'none' ? null : n.layout.direction
  const styles: Record<string, string | number | undefined> = {
    display: flexDir ? 'flex' : undefined,
    flexDirection: flexDir ?? undefined,
    paddingTop: n.layout.paddingTop || undefined,
    paddingRight: n.layout.paddingRight || undefined,
    paddingBottom: n.layout.paddingBottom || undefined,
    paddingLeft: n.layout.paddingLeft || undefined,
    gap: n.layout.gap || undefined,
    alignItems: flexDir && n.layout.alignItems !== 'start' ? n.layout.alignItems : undefined,
    justifyContent: flexDir && n.layout.justifyContent !== 'start' ? n.layout.justifyContent : undefined,
    width: n.width,
    height: n.height,
    background: n.background,
    borderRadius: n.borderRadius,
  }
  const styleStr = Object.entries(styles)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? v : JSON.stringify(v)}`)
    .join(', ')
  const styleAttr = styleStr ? ` style={{ ${styleStr} }}` : ''
  if (n.children.length === 0) return `${pad}<div${styleAttr} />`
  const inner = n.children.map((c) => emit(c, depth + 1)).join('\n')
  return `${pad}<div${styleAttr}>\n${inner}\n${pad}</div>`
}

function emitText(n: IRText, pad: string): string {
  const styles = [
    `fontSize: ${n.fontSize}`,
    `lineHeight: ${JSON.stringify(`${n.lineHeight}px`)}`,
    `fontWeight: ${n.fontWeight}`,
    `color: ${JSON.stringify(n.color)}`,
    n.textAlign ? `textAlign: ${JSON.stringify(n.textAlign)}` : '',
  ].filter(Boolean).join(', ')
  return `${pad}<span style={{ ${styles} }}>${escapeJsx(n.content)}</span>`
}

function emitVector(n: IRVector, pad: string): string {
  return `${pad}<div style={{ width: ${n.width}, height: ${n.height}, background: ${JSON.stringify(n.fills[0] ?? '#ccc')} }} /> {/* vector ${n.figmaName} */}`
}

function emitUnknown(n: IRUnknown, pad: string): string {
  return `${pad}<div style={{ width: ${n.width}, height: ${n.height}, background: '#f00' }} /> {/* unknown ${n.type}: ${n.figmaName} */}`
}

function escapeJsx(s: string): string {
  return s.replace(/[<>{}]/g, (c) => `{'${c}'}`)
}

/** Generate a self-contained tsx file for the given IR root. */
export function generate(root: IRNode, components: Component<unknown>[]): string {
  hydrate(root, components)
  const usedComponents = new Set<string>()
  collectComponents(root, usedComponents)
  const imports = [...usedComponents].sort().map((n) => `import { ${n} } from 'danah'`).join('\n')
  return `${imports}\n\nexport const Generated = () => (\n${emit(root, 1)}\n)\n`
}

function collectComponents(node: IRNode, set: Set<string>): void {
  if (node.kind === 'component') set.add(node.componentName)
  if (node.kind === 'frame') for (const c of node.children) collectComponents(c, set)
}
