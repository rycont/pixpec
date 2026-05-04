// DEPRECATED 2026-05-02 — replaced by Rust npm bin `pixpec-measure`
// (measure-rs/). Source kept commented out for reference only; do not
// import. Will be deleted once consumers stop pulling on the old types.

// /**
//  * Process-based measure pool. Spawns N child node processes (each running
//  * `measure-worker.ts` via tsx), feeds jobs as JSON lines to stdin, reads
//  * results from stdout. Avoids worker_threads opencv.js loader quirks.
//  *
//  * opencv.js init takes ~1s per process — pool size of 4 amortizes well.
//  */
// import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
// import { fileURLToPath } from 'node:url'
// import { dirname, resolve } from 'node:path'
// import os from 'node:os'
// import readline from 'node:readline'
// import type { MeasureResult } from './measure.ts'
//
// const HERE = dirname(fileURLToPath(import.meta.url))
// const WORKER_PATH = resolve(HERE, 'measure-worker.ts')
//
// export interface MeasureJob {
//   figmaPath: string
//   implPath: string
// }
//
// interface ChildState {
//   proc: ChildProcessWithoutNullStreams
//   rl: readline.Interface
//   busy: boolean
//   pending: { resolve: (m: MeasureResult) => void; reject: (e: Error) => void } | null
//   ready: boolean
//   onReady: (() => void) | null
// }
//
// export async function measureBatch(
//   jobs: MeasureJob[],
//   poolSize?: number,
// ): Promise<MeasureResult[]> {
//   if (jobs.length === 0) return []
//   const N = Math.min(jobs.length, poolSize ?? Math.min(os.cpus().length, 4))
//   process.stderr.write(`[pool] starting with N=${N} workers, ${jobs.length} jobs\n`)
//   process.on('exit', (code) => {
//     process.stderr.write(`[parent] exit code=${code}\n`)
//   })
//   process.on('uncaughtException', (e) => {
//     process.stderr.write(`[parent uncaught] ${(e as Error).stack ?? e}\n`)
//   })
//   process.on('unhandledRejection', (e) => {
//     process.stderr.write(`[parent unhandled] ${(e as Error)?.stack ?? e}\n`)
//   })
//
//   // Forward-declare shared mutable state so spawn-time event handlers (proc.exit/error)
//   // can reference them before the dispatch loop runs.
//   const results: MeasureResult[] = new Array(jobs.length)
//   let nextIdx = 0
//   let done = 0
//   let finishCalled = false
//   let finishResolve: () => void = () => {}
//   let finishReject: (e: Error) => void = () => {}
//   const finishPromise = new Promise<void>((res, rej) => {
//     finishResolve = res
//     finishReject = rej
//   })
//   const finish = (err?: Error) => {
//     if (finishCalled) return
//     finishCalled = true
//     if (err) finishReject(err)
//     else finishResolve()
//   }
//
//   // Spawn workers; wait until each prints { ready: true }.
//   const children: ChildState[] = []
//   for (let i = 0; i < N; i++) {
//     // Spawn worker with same node + tsx loader flags as the parent. Avoids
//     // the npm/sh/tsx wrapper chain that breaks SIGKILL/stdin-EOF propagation
//     // and leaves zombie workers when the parent is killed.
//     const proc = spawn(
//       process.execPath,
//       [...process.execArgv, WORKER_PATH],
//       { stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
//     )
//     // Always forward worker stderr to parent so we never silently lose errors.
//     // Worker debug lines from PIXPEC_DEBUG inside measure.ts go through here.
//     proc.stderr.on('data', (b) => process.stderr.write(b))
//     const rl = readline.createInterface({ input: proc.stdout })
//     const state: ChildState = { proc, rl, busy: false, pending: null, ready: false, onReady: null }
//     children.push(state)
//     proc.on('exit', (code, signal) => {
//       // Log every exit so silent worker death never hides.
//       process.stderr.write(
//         `[pool] worker pid=${proc.pid} exit code=${code} signal=${signal}  done=${done}/${jobs.length} finishCalled=${finishCalled}\n`,
//       )
//       if (done < jobs.length && !finishCalled) {
//         const err = new Error(
//           `measure worker died unexpectedly (code=${code}, signal=${signal}). ${done}/${jobs.length} done.`,
//         )
//         if (state.pending) {
//           const p = state.pending
//           state.pending = null
//           p.reject(err)
//         }
//         finish(err)
//       }
//     })
//     proc.on('error', (err) =>
//       finish(err instanceof Error ? err : new Error(String(err))),
//     )
//     rl.on('line', (line) => {
//       let msg: { ready?: boolean; ok?: boolean; result?: MeasureResult; error?: string }
//       try {
//         msg = JSON.parse(line)
//       } catch {
//         return
//       }
//       if (msg.ready) {
//         state.ready = true
//         if (state.onReady) {
//           const cb = state.onReady
//           state.onReady = null
//           cb()
//         }
//         return
//       }
//       const p = state.pending
//       state.pending = null
//       state.busy = false
//       if (!p) return
//       if (msg.ok && msg.result) p.resolve(msg.result)
//       else p.reject(new Error(msg.error ?? 'measure worker error'))
//     })
//   }
//
//   await Promise.all(
//     children.map(
//       (s) =>
//         new Promise<void>((res) => {
//           if (s.ready) res()
//           else s.onReady = res
//         }),
//     ),
//   )
//
//   const dispatch = (s: ChildState) => {
//     if (nextIdx >= jobs.length) return
//     const idx = nextIdx++
//     s.busy = true
//     s.pending = {
//       resolve: (m) => {
//         results[idx] = m
//         done++
//         if (done === jobs.length) finish()
//         else dispatch(s)
//       },
//       reject: (e) => finish(e),
//     }
//     const ok = s.proc.stdin.write(JSON.stringify({ id: idx, ...jobs[idx] }) + '\n')
//     if (process.env.PIXPEC_DEBUG && idx < 10) console.error(`[pool] dispatch idx=${idx} write=${ok}`)
//   }
//
//   if (process.env.PIXPEC_DEBUG) console.error(`[pool] all ${N} ready, dispatching ${jobs.length} jobs`)
//   for (const s of children) dispatch(s)
//   await finishPromise
//   if (process.env.PIXPEC_DEBUG) console.error(`[pool] all done`)
//
//   for (const s of children) {
//     s.proc.stdin.end()
//     s.proc.kill()
//   }
//   return results
// }
