/**
 * Quick validation test for the react-panda target codegen.
 *
 * Builds a synthetic Design AST modeled after the TabItem variant b master
 * (figma node 2127:1825) and feeds it through the emitter. Compares the
 * shape of the generated TSX against the expected output.
 *
 * Run with:  pnpm tsx src/targets/react-panda/test-tabitem.ts
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
import { codegenReactPanda } from './codegen.ts'
import type { CodegenContext } from '../types.ts'

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
      visible: { kind: 'expression', type: 'prop', name: 'leftIcon' },
      // extension: instance prop bindings.
      instancePropBindings: { Type: 'iconType', _fill: 'iconFill' },
    } as DNode,
    // Label text
    {
      kind: NodeKind.Text,
      sourceId: '2127:1820',
      sourceName: 'Label',
      content: { kind: 'expression', type: 'prop', name: 'label' },
      fontSize: { value: 14, unit: 'px' },
      lineHeight: { value: 20, unit: 'px' },
      color: { kind: 'literal', source: 'token', path: 'content.standard.primary' },
      textStyleRef: { kind: 'literal', source: 'raw', value: 'S:body-regular,' },
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

const ctx: CodegenContext = {
  componentName: 'TabItem',
  designSystem: {
    typography: { 'S:body-regular,': 'BodyRegular' },
    tokens: { 'VariableID:icon-color': 'content.standard.primary' },
  },
  registry: new Map([
    ['Icon', { componentName: 'Icon', dir: '/danah/src/components/Icon' }],
  ]),
  remBase: 16,
  plugins: [],
}

const result = await codegenReactPanda(root, ctx)
console.log('// fileExtension:', result.fileExtension)
console.log(result.source)
