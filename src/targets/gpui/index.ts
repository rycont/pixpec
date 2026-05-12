import type { CompileTarget } from '../types.ts'
import { codegenGpui } from './codegen.ts'
import { captureGpuiDestination } from './capture.ts'

export const gpuiTarget: CompileTarget = {
  name: 'gpui',
  description: 'Rust + GPUI components.',
  codegen: codegenGpui,
  capture: captureGpuiDestination,
}
