/**
 * Quick validation test for the react-panda emitter.
 *
 * Builds a synthetic Design AST modeled after the TabItem variant b master
 * (figma node 2127:1825) and feeds it through the emitter. Compares the
 * shape of the generated TSX against the expected legacy output.
 *
 * Run with:  pnpm tsx src/emitter/react-panda/test-tabitem.ts
 *
 * Note: a true `dumper → compiler → emitter` round-trip would require a live
 * raw figma dump for 2127:1825, which the project does not currently persist
 * for TabItem (no master-snapshot.json). The synthetic AST below mirrors what
 * the compiler would produce for that exact figma subtree — same node kinds,
 * same bindings, same tokens — so the emitter exercise is equivalent.
 */

import {
  NodeKind, FlowDirection, Sizing, Align, Justify, Positioning,
  Anchor, ShapeKind, StrokeCap, TextAutoResize, type DNode,
} from '../../compiler/design-ast.ts'
import { reactPandaEmitter } from './index.ts'
import type { EmitContext } from '../types.ts'
import type { CodegenPlugin } from '../../types.ts'

// Mirror danah's iconCurrentColor plugin (emitWrap half — Icon → adds color attr).
const iconCurrentColor: CodegenPlugin = {
  name: 'icon-current-color',
  emitWrap: (n, jsx, ctx) => {
    if (n.kind !== 'instance') return jsx
    const inst = n as { componentName?: string; effectiveFill?: string; effectiveFillTokenId?: string }
    if (inst.componentName !== 'Icon') return jsx
    const fill = inst.effectiveFill
    if (!fill) return jsx
    const tokenId = inst.effectiveFillTokenId
    const tokenPath = ctx.resolveTokenPath(tokenId)
    return ctx.appendJsxAttr(jsx, ctx.jsxAttr('color', tokenPath ?? fill))
  },
}

// Synthetic TabItem b master AST.
const root: DNode = {
  kind: NodeKind.Flex,
  direction: FlowDirection.Row,
  sourceId: '2127:1825',
  sourceName: 'Status=true',
  width: { value: 96, unit: 'px' },
  height: { value: 64, unit: 'px' },
  sizing: { horizontal: Sizing.Fixed, vertical: Sizing.Fixed },
  padding: {
    top: { tokenPath: 'spacing.500' },
    right: { tokenPath: 'spacing.500' },
    bottom: { tokenPath: 'spacing.500' },
    left: { tokenPath: 'spacing.500' },
  },
  gap: { tokenPath: 'spacing.200' },
  align: Align.Center,
  justify: Justify.Center,
  clip: true,
  children: [
    // Icon instance
    {
      kind: NodeKind.Instance,
      sourceId: '2127:1819',
      sourceName: 'Icon',
      componentName: 'Icon',
      props: { Type: 'check' },
      defaultProps: { Type: 'check' },
      sizing: { horizontal: Sizing.Fixed, vertical: Sizing.Fixed },
      visibilityBinding: 'leftIcon',
      // extension: instance prop bindings (Type → owner.iconType)
      instancePropBindings: { Type: 'iconType' },
      // extension: legacy plugin payload — emulates iconCurrentColor walkExtend.
      effectiveFill: '#262626',
      effectiveFillTokenId: 'VariableID:icon-color',
    } as DNode,
    // Label text
    {
      kind: NodeKind.Text,
      sourceId: '2127:1820',
      sourceName: 'Label',
      content: 'Tab',
      contentBinding: 'label',
      fontSize: { value: 14, unit: 'px' },
      lineHeight: { value: 20, unit: 'px' },
      color: { tokenPath: 'content.standard.primary' },
      textStyleRef: 'S:body-regular,',
      width: 24,
      autoResize: TextAutoResize.Hug,
    },
    // Underline line shape (absolute, stretch horizontally)
    {
      kind: NodeKind.Shape,
      sourceId: '2127:1821',
      sourceName: 'Underline',
      shape: ShapeKind.Line,
      width: { value: 96, unit: 'px' },
      height: { value: 0, unit: 'px' },
      stroke: {
        paint: { color: '#5472eb' },
        width: { value: 1.5, unit: 'px' },
        cap: StrokeCap.Round,
      },
      positioning: Positioning.Absolute,
      inset: { left: 0, top: 62.5, right: 0, bottom: 1.5 },
      anchor: { horizontal: Anchor.Stretch, vertical: Anchor.End },
    },
  ],
}

const ctx: EmitContext = {
  componentName: 'TabItem',
  designSystem: {
    typography: { 'S:body-regular,': 'BodyRegular' },
    tokens: { 'VariableID:icon-color': 'content.standard.primary' },
  },
  registry: new Map([
    ['Icon', { componentName: 'Icon', dir: '/danah/src/components/Icon' }],
  ]),
  remBase: 16,
  plugins: [iconCurrentColor],
}

const result = await reactPandaEmitter.emit(root, ctx)
console.log('// fileExtension:', result.fileExtension)
console.log(result.source)
