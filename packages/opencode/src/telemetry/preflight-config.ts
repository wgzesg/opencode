import fs from "fs"
import path from "path"
import os from "os"
import { parse as parseJsonc } from "jsonc-parser"

/**
 * Preflight config loader.
 *
 * Runs BEFORE {@link Log.init} and OTel bootstrap, so it cannot use the main
 * Config.get() pipeline (which loads providers, plugins, etc., and also logs).
 * Instead, we synchronously read the `telemetry` block out of known config
 * locations, returning either the parsed values or undefined.
 *
 * Precedence (highest first):
 *   1. project `opencode.json` / `opencode.jsonc` found via upward search
 *   2. `$OPENCODE_CONFIG_DIR/opencode.json(c)`
 *   3. `~/.config/opencode/opencode.json(c)` and `~/.opencode/opencode.json(c)`
 *
 * Env var fallback (lowest) is applied by the consumer (log-tls, otel bootstrap),
 * not here. This function only returns what it found in config files.
 */
export namespace TelemetryPreflight {
  export interface LogsConfig {
    provider?: string
    accessKeyId?: string
    accessKeySecret?: string
    endpoint?: string
    region?: string
    topicId?: string
    source?: string
    enabled?: boolean
  }

  export interface TracesConfig {
    provider?: string
    endpoint?: string
    serviceName?: string
    sampleRatio?: number
    enabled?: boolean
  }

  export interface Telemetry {
    logs?: LogsConfig
    traces?: TracesConfig
  }

  let cache: Telemetry | undefined
  let cacheLoaded = false
  let defaultCwd: string | undefined

  function readFileMaybe(p: string): string | undefined {
    try {
      return fs.readFileSync(p, "utf8")
    } catch {
      return undefined
    }
  }

  function parseMaybe(text: string | undefined): any | undefined {
    if (!text) return undefined
    try {
      return parseJsonc(text)
    } catch {
      return undefined
    }
  }

  function* candidatePaths(cwd: string): IterableIterator<string> {
    const homedir = process.env.HOME ?? os.homedir()
    const files = ["opencode.json", "opencode.jsonc"]

    // 1. upward search from cwd
    let dir = path.resolve(cwd)
    while (true) {
      for (const f of files) yield path.join(dir, f)
      for (const f of files) yield path.join(dir, ".opencode", f)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }

    // 2. OPENCODE_CONFIG explicit path
    if (process.env.OPENCODE_CONFIG) yield process.env.OPENCODE_CONFIG

    // 3. OPENCODE_CONFIG_DIR
    if (process.env.OPENCODE_CONFIG_DIR) {
      for (const f of files) yield path.join(process.env.OPENCODE_CONFIG_DIR, f)
    }

    // 4. ~/.config/opencode/
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homedir, ".config")
    for (const f of files) yield path.join(xdgConfig, "opencode", f)

    // 5. ~/.opencode/
    for (const f of files) yield path.join(homedir, ".opencode", f)
  }

  function merge(a: Telemetry | undefined, b: Telemetry | undefined): Telemetry | undefined {
    if (!a && !b) return undefined
    const out: Telemetry = {}
    if (a?.logs || b?.logs) out.logs = { ...(b?.logs ?? {}), ...(a?.logs ?? {}) }
    if (a?.traces || b?.traces) out.traces = { ...(b?.traces ?? {}), ...(a?.traces ?? {}) }
    return out
  }

  /** Synchronous load. Safe to call multiple times; cached after first call. */
  export function load(cwd?: string): Telemetry {
    if (cacheLoaded) return cache ?? {}
    cacheLoaded = true
    const effectiveCwd = cwd ?? defaultCwd ?? process.cwd()
    const seen = new Set<string>()
    let merged: Telemetry | undefined
    for (const p of candidatePaths(effectiveCwd)) {
      const abs = path.resolve(p)
      if (seen.has(abs)) continue
      seen.add(abs)
      const parsed = parseMaybe(readFileMaybe(abs))
      if (parsed && typeof parsed === "object" && parsed.telemetry && typeof parsed.telemetry === "object") {
        merged = merge(merged, parsed.telemetry as Telemetry)
      }
    }
    cache = merged
    return cache ?? {}
  }

  /** Reset the cache. Test-only. */
  export function resetForTest(): void {
    cache = undefined
    cacheLoaded = false
    defaultCwd = undefined
  }

  /** Override the default cwd used by subsequent `load()` calls. Test-only. */
  export function setDefaultCwdForTest(cwd: string | undefined): void {
    defaultCwd = cwd
  }
}
