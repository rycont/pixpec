import type { CompileTarget } from '../types.ts'
import { codegenReactPanda } from './codegen.ts'
import { captureReactPandaDestination } from './capture.ts'

export const reactPandaTarget: CompileTarget = {
  name: 'react-panda',
  description: 'React + PandaCSS components.',
  codegen: codegenReactPanda,
  capture: captureReactPandaDestination,
}
