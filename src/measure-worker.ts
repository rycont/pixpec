// DEPRECATED 2026-05-02 — replaced by Rust npm bin `pixpec-measure`
// (measure-rs/). Source kept commented out for reference only; do not
// import. Will be deleted once consumers stop pulling on the old types.

// /**
//  * Child-process measure worker. Reads JSON jobs (one per line) from stdin,
//  * runs `measureHsbDiff`, writes JSON results to stdout. opencv.js loaded
//  * once at startup; the parent emits a `{"ready":true}` line so the dispatcher
//  * knows we're warm.
//  *
//  * Used by measure-pool.ts for parallel measure phase.
//  */
// import { measureHsbDiff } from './measure.ts'
// import readline from 'node:readline'
//
// interface Job {
//   id: number
//   figmaPath: string
//   implPath: string
// }
//
// // Surface ANY error so silent worker death never goes unnoticed.
// process.on('uncaughtException', (e) => {
//   process.stderr.write(`[worker uncaught] ${(e as Error).stack ?? e}\n`)
//   process.exit(2)
// })
// process.on('unhandledRejection', (e) => {
//   process.stderr.write(`[worker unhandled] ${(e as Error)?.stack ?? e}\n`)
//   process.exit(3)
// })
//
// const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n')
//
// // Touch opencv.js eagerly so subsequent measures don't pay init.
// async function warmup() {
//   // measureHsbDiff calls ensureReady() internally; trigger it without doing work.
//   // Easiest: do nothing here, let first job pay init. But to signal "ready"
//   // BEFORE first job, we eagerly import + await ensureReady via a direct call.
//   // The simpler path: just print ready and let init happen on first job —
//   // dispatcher accounts for first-call slowness via natural pipeline.
//   send({ ready: true })
// }
//
// const rl = readline.createInterface({ input: process.stdin })
// rl.on('line', async (line) => {
//   let job: Job
//   try {
//     job = JSON.parse(line)
//   } catch {
//     return
//   }
//   try {
//     const result = await measureHsbDiff(job.figmaPath, job.implPath)
//     send({ id: job.id, ok: true, result })
//   } catch (e) {
//     send({ id: job.id, ok: false, error: String((e as Error).message ?? e) })
//   }
// })
// rl.on('close', () => process.exit(0))
//
// warmup()
