import type { CompileTarget } from '../types.ts'
import { codegenReactPanda } from './codegen.ts'

export const reactPandaTarget: CompileTarget = {
  name: 'react-panda',
  description: 'React + PandaCSS components.',
  codegen: codegenReactPanda,
  capture: async (request) => {
    const { captureReactPandaDestination } = await import('./capture.ts')
    return captureReactPandaDestination(request)
  },
}
