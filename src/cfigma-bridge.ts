/**
 * pixpec ↔ cfigma bridge HTTP client.
 *
 * Replaces the old `execFile(cfigmaBin, ...)` subprocess pattern. The bridge
 * runs once (`cfigma bridge` with `CFIGMA_BRIDGE_TOKEN` env), exposes
 * /exec /export /reload /tabs, and pixpec talks to it via fetch.
 *
 * Per-call savings: no `pnpm exec` cold start, no node startup, no CDP
 * re-attach. Each request is a localhost fetch (~5-10ms overhead).
 *
 * Token is read from `CFIGMA_BRIDGE_TOKEN` env. URL from
 * `PIXPEC_CFIGMA_BRIDGE` env or pixpec.toml `cfigmaBridgeUrl`, default
 * `http://127.0.0.1:9876`.
 */

export interface ExecOpts {
  awaitPromise?: boolean
  timeoutSec?: number
}

export interface ExportOpts {
  format?: 'PNG' | 'JPG' | 'SVG' | 'PDF'
  scale?: number
  selector:
    | { kind: 'page' }
    | { kind: 'selection' }
    | { kind: 'all-text' }
    | { kind: 'all-frames' }
    | { kind: 'ids'; ids: string }
    | { kind: 'filter'; body: string }
  out?: string
  concurrency?: number
}

export interface BridgeClient {
  /** Run JS in tab; return parsed result. */
  exec<T = unknown>(tab: string, code: string, opts?: ExecOpts): Promise<T>
  /** Bulk export (PNG/JPG/SVG/PDF) — mirrors `cfigma export` flags. */
  export(tab: string, opts: ExportOpts): Promise<{ ok: boolean; out_dir: string; rate_per_sec?: number }>
  /** Reload tab + reinstall __capturedCpp interceptor. */
  reload(tab: string): Promise<{ ok: boolean }>
  /** List visible design tabs (no auth, but client passes token anyway). */
  tabs(): Promise<{ ok: boolean; tabs: Array<{ title: string; url: string; fileKey: string | null; webSocketDebuggerUrl: string; permission: { read: boolean; write: boolean; note: string | null } }> }>
}

class HttpBridge implements BridgeClient {
  constructor(private url: string, private token: string) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url + path, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
    if (!res.ok) {
      throw new Error(`cfigma-bridge ${path} → HTTP ${res.status}: ${text}`)
    }
    const obj = parsed as { ok?: boolean; error?: string; result?: T } & T
    if (obj && obj.ok === false) {
      throw new Error(`cfigma-bridge ${path} → ${obj.error ?? 'unknown error'}`)
    }
    return obj as T
  }

  async exec<T>(tab: string, code: string, opts: ExecOpts = {}): Promise<T> {
    const r = await this.post<{ result: T }>('/exec', {
      tab, code,
      awaitPromise: opts.awaitPromise ?? true,
      timeoutSec: opts.timeoutSec ?? 600,
    })
    return r.result
  }

  async export(tab: string, opts: ExportOpts) {
    return await this.post<{ ok: boolean; out_dir: string; rate_per_sec?: number }>(
      '/export',
      {
        tab,
        format: opts.format ?? 'PNG',
        scale: opts.scale ?? 1,
        selector: opts.selector,
        ...(opts.out ? { out: opts.out } : {}),
        ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
      },
    )
  }

  async reload(tab: string) {
    return await this.post<{ ok: boolean }>('/reload', { tab })
  }

  async tabs() {
    const res = await fetch(this.url + '/tabs', {
      headers: { 'authorization': `Bearer ${this.token}` },
    })
    if (!res.ok) throw new Error(`cfigma-bridge /tabs → HTTP ${res.status}`)
    return await res.json()
  }
}

let cached: BridgeClient | null = null
let cachedKey: string | null = null

export function getBridge(opts?: { url?: string; token?: string }): BridgeClient {
  const url = (opts?.url ?? process.env.PIXPEC_CFIGMA_BRIDGE ?? 'http://127.0.0.1:9876').replace(/\/$/, '')
  const token = opts?.token ?? process.env.CFIGMA_BRIDGE_TOKEN ?? ''
  if (!token) {
    throw new Error(
      'cfigma bridge: CFIGMA_BRIDGE_TOKEN env var not set.\n' +
      '  Start the bridge with that env (the bridge prints it to stderr if unset and auto-generates one).\n' +
      '  pixpec must use the same value to authenticate against /exec, /export, /reload.',
    )
  }
  const key = `${url}|${token}`
  if (cached && cachedKey === key) return cached
  cached = new HttpBridge(url, token)
  cachedKey = key
  return cached
}
