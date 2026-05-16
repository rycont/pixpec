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
    Align,
    Anchor,
    type DNode,
    FlowDirection,
    Justify,
    NodeKind,
    Positioning,
    ShapeKind,
    Sizing,
    StrokeCap,
    TextAutoResize,
} from '../../compiler/design-ast.ts'
import type { CodegenContext } from '../types.ts'
import { codegenReactPanda } from './codegen.ts'

// Synthetic TabItem b master AST.
const inner: DNode = {
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
            props: {
                Type: { kind: 'expression', type: 'prop', name: 'iconType' },
                _fill: { kind: 'expression', type: 'prop', name: 'iconFill' },
            },
            sizing: { horizontal: Sizing.Fixed, vertical: Sizing.Fixed },
            visible: { kind: 'expression', type: 'prop', name: 'leftIcon' },
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

const root: DNode = {
    kind: NodeKind.DataScope,
    componentName: 'TabItem',
    data: {
        label: { type: 'string' },
        leftIcon: { type: 'boolean' },
        iconType: { type: 'string' },
        iconFill: { type: 'color' },
    },
    child: inner,
}

const ctx: CodegenContext = {
    componentName: 'TabItem',
    designSystem: {
        typography: { 'S:body-regular,': 'BodyRegular' },
        tokens: { 'VariableID:icon-color': 'content.standard.primary' },
    },
    registry: new Map([['Icon', { componentName: 'Icon', dir: '/danah/src/components/Icon' }]]),
    remBase: 16,
}

const result = await codegenReactPanda(root, ctx)
console.log('// fileExtension:', result.fileExtension)
console.log(result.source)
