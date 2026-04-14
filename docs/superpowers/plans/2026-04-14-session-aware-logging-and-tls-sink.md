# Session-Aware Logging and Volcengine TLS Sink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic `sessionID` tagging to opencode logs via `AsyncLocalStorage`, and optionally ship every log line to a Volcengine TLS log topic via an additional sink, configured entirely through environment variables.

**Architecture:**
1. An `AsyncLocalStorage`-backed `Log.withSession(sessionID, fn)` in `packages/opencode/src/util/log.ts` automatically prefixes `sessionID=…` into every line emitted inside the wrapped async context.
2. A new `packages/opencode/src/util/log-tls.ts` module maintains a capped in-memory ring buffer and a background timer that flushes batched records to Volcengine TLS via `@volcengine/openapi`'s `PutLogs`. `Log.create()` call sites enqueue every emitted line to the TLS sink in addition to the existing stderr/file sink.
3. Hono middleware in the server plus targeted wraps in CLI/TUI/projectors establish the session async context once per session-owned entrypoint.

**Tech Stack:** TypeScript, Bun (test runner), Hono (server), `@volcengine/openapi` (new dep), Node `async_hooks.AsyncLocalStorage`.

**Spec:** `docs/superpowers/specs/2026-04-14-session-aware-logging-and-tls-sink-design.md`

---

## File Structure

**Modified:**
- `packages/opencode/src/util/log.ts` — adds `withSession`, `currentSessionID`, merges implicit sessionID into `build()`, calls `LogTls.enqueue()` from each level method.
- `packages/opencode/src/server/server.ts` — registers a Hono middleware that wraps each session-scoped request in `Log.withSession`.
- `packages/opencode/src/cli/cmd/run.ts` — wraps the run body once a sessionID exists.
- `packages/opencode/src/cli/cmd/tui/worker.ts` — wraps the TUI worker loop when handling a session.
- `packages/opencode/src/server/projectors.ts` — wraps projector callbacks in `withSession` when a record carries `sessionID`.
- `packages/opencode/src/index.ts` — registers `beforeExit` / `SIGINT` / `SIGTERM` handler that flushes `LogTls`.
- `packages/opencode/package.json` — adds `@volcengine/openapi` dependency.

**Created:**
- `packages/opencode/src/util/log-tls.ts` — env-driven TLS sink with ring buffer, timer, flush, shutdown.
- `packages/opencode/test/util/log.test.ts` — tests for `withSession` propagation and merging.
- `packages/opencode/test/util/log-tls.test.ts` — tests for ring buffer, flush triggers, overflow, no-op on missing env.

---

## Task 1: Add `AsyncLocalStorage` session context to `Log`

**Files:**
- Modify: `packages/opencode/src/util/log.ts`
- Test: `packages/opencode/test/util/log.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/opencode/test/util/log.test.ts`:

```ts
import { describe, expect, test, afterEach, beforeEach, spyOn } from "bun:test"
import { Log } from "../../src/util/log"

describe("Log.withSession", () => {
  let written: string[] = []
  let spy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    written = []
    spy = spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      written.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    spy?.mockRestore()
  })

  test("injects sessionID into log lines emitted inside withSession", () => {
    const log = Log.create({ service: "test-withsession" })
    Log.withSession("ses_abc123", () => {
      log.info("hello")
    })
    const line = written.find((l) => l.includes("hello"))!
    expect(line).toContain("sessionID=ses_abc123")
  })

  test("does not inject sessionID outside withSession", () => {
    const log = Log.create({ service: "test-outside" })
    log.info("plain")
    const line = written.find((l) => l.includes("plain"))!
    expect(line).not.toContain("sessionID=")
  })

  test("inner withSession overrides outer", () => {
    const log = Log.create({ service: "test-nested" })
    Log.withSession("outer", () => {
      Log.withSession("inner", () => {
        log.info("nested")
      })
    })
    const line = written.find((l) => l.includes("nested"))!
    expect(line).toContain("sessionID=inner")
    expect(line).not.toContain("sessionID=outer")
  })

  test("explicit extra sessionID wins over implicit", () => {
    const log = Log.create({ service: "test-override" })
    Log.withSession("implicit", () => {
      log.info("override", { sessionID: "explicit" })
    })
    const line = written.find((l) => l.includes("override"))!
    expect(line).toContain("sessionID=explicit")
    expect(line).not.toContain("sessionID=implicit")
  })

  test("currentSessionID returns the current context's id", () => {
    let seen: string | undefined
    Log.withSession("ses_xyz", () => {
      seen = Log.currentSessionID()
    })
    expect(seen).toBe("ses_xyz")
    expect(Log.currentSessionID()).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/opencode && bun test test/util/log.test.ts`
Expected: FAIL — `Log.withSession is not a function` / `Log.currentSessionID is not a function`.

- [ ] **Step 3: Add `AsyncLocalStorage` + `withSession` + merge in `build()`**

Edit `packages/opencode/src/util/log.ts`. At the top of the file, add:

```ts
import { AsyncLocalStorage } from "async_hooks"
```

Inside `export namespace Log { ... }`, after the existing `loggers` map declaration and before `export const Default`, add:

```ts
  const sessionStore = new AsyncLocalStorage<{ sessionID: string }>()

  export function withSession<T>(sessionID: string, fn: () => T): T {
    return sessionStore.run({ sessionID }, fn)
  }

  export function currentSessionID(): string | undefined {
    return sessionStore.getStore()?.sessionID
  }
```

In the `build()` function inside `create()`, replace the first line:

```ts
      const prefix = Object.entries({
        ...tags,
        ...extra,
      })
```

with:

```ts
      const implicit = sessionStore.getStore()
      const prefix = Object.entries({
        ...(implicit?.sessionID ? { sessionID: implicit.sessionID } : {}),
        ...tags,
        ...extra,
      })
```

This inserts `sessionID` first so explicit `tags` / `extra` can overwrite it if specified.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/opencode && bun test test/util/log.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/opencode && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/util/log.ts packages/opencode/test/util/log.test.ts
git commit -m "feat(log): add Log.withSession async context for sessionID tagging"
```

---

## Task 2: Create `LogTls` module (disabled path only)

We build the sink incrementally. First pass: module exists, disabled when env is missing, no network calls.

**Files:**
- Create: `packages/opencode/src/util/log-tls.ts`
- Test: `packages/opencode/test/util/log-tls.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/opencode/test/util/log-tls.test.ts`:

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test"

const REQUIRED_ENV = [
  "VOLCENGINE_ACCESS_KEY_ID",
  "VOLCENGINE_ACCESS_KEY_SECRET",
  "VOLCENGINE_ENDPOINT",
  "VOLCENGINE_REGION",
  "OPENCODE_TLS_TOPIC_ID",
]

function clearEnv(saved: Record<string, string | undefined>) {
  for (const key of REQUIRED_ENV) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  saved["OPENCODE_TLS_DISABLED"] = process.env["OPENCODE_TLS_DISABLED"]
  delete process.env["OPENCODE_TLS_DISABLED"]
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe("LogTls (disabled)", () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => clearEnv(saved))
  afterEach(() => restoreEnv(saved))

  test("enqueue is a no-op when required env is missing", async () => {
    // Re-import after env clear to re-evaluate lazy init
    const { LogTls } = await import(`../../src/util/log-tls?t=${Date.now()}`)
    expect(LogTls.isEnabled()).toBe(false)
    // Should not throw and should not buffer
    LogTls.enqueue({ time: Date.now(), level: "INFO", message: "m", tags: {} })
    expect(LogTls.bufferSize()).toBe(0)
  })

  test("disabled when OPENCODE_TLS_DISABLED=1 even with full env", async () => {
    process.env.VOLCENGINE_ACCESS_KEY_ID = "k"
    process.env.VOLCENGINE_ACCESS_KEY_SECRET = "s"
    process.env.VOLCENGINE_ENDPOINT = "tls-cn-beijing.volces.com"
    process.env.VOLCENGINE_REGION = "cn-beijing"
    process.env.OPENCODE_TLS_TOPIC_ID = "topic-1"
    process.env.OPENCODE_TLS_DISABLED = "1"
    const { LogTls } = await import(`../../src/util/log-tls?t=${Date.now()}`)
    expect(LogTls.isEnabled()).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/opencode && bun test test/util/log-tls.test.ts`
Expected: FAIL — `Cannot find module '../../src/util/log-tls'`.

- [ ] **Step 3: Create the disabled-only module**

Create `packages/opencode/src/util/log-tls.ts`:

```ts
export namespace LogTls {
  export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR"

  export interface Record {
    time: number
    level: Level
    message: string
    tags: globalThis.Record<string, unknown>
  }

  interface Config {
    accessKeyId: string
    accessKeySecret: string
    endpoint: string
    region: string
    topicId: string
    source: string
  }

  let config: Config | undefined
  let enabled = false
  let buffer: Record[] = []
  const MAX_BUFFER = 5000

  function readConfig(): Config | undefined {
    if (process.env.OPENCODE_TLS_DISABLED === "1" || process.env.OPENCODE_TLS_DISABLED === "true") {
      return undefined
    }
    const ak = process.env.VOLCENGINE_ACCESS_KEY_ID
    const sk = process.env.VOLCENGINE_ACCESS_KEY_SECRET
    const endpoint = process.env.VOLCENGINE_ENDPOINT
    const region = process.env.VOLCENGINE_REGION
    const topicId = process.env.OPENCODE_TLS_TOPIC_ID
    if (!ak || !sk || !endpoint || !region || !topicId) return undefined
    return {
      accessKeyId: ak,
      accessKeySecret: sk,
      endpoint,
      region,
      topicId,
      source: process.env.OPENCODE_TLS_SOURCE ?? "opencode",
    }
  }

  function init() {
    config = readConfig()
    enabled = config !== undefined
  }

  init()

  export function isEnabled(): boolean {
    return enabled
  }

  export function bufferSize(): number {
    return buffer.length
  }

  export function enqueue(record: Record): void {
    if (!enabled) return
    if (buffer.length >= MAX_BUFFER) {
      buffer.shift()
    }
    buffer.push(record)
  }

  export async function shutdown(): Promise<void> {
    // No-op in Task 2; wired up in Task 4.
    buffer = []
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/opencode && bun test test/util/log-tls.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/opencode && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/util/log-tls.ts packages/opencode/test/util/log-tls.test.ts
git commit -m "feat(log): add LogTls module scaffold (disabled when env missing)"
```

---

## Task 3: Wire `Log.create()` level methods to `LogTls.enqueue`

**Files:**
- Modify: `packages/opencode/src/util/log.ts`
- Test: `packages/opencode/test/util/log-tls.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/opencode/test/util/log-tls.test.ts`:

```ts
describe("LogTls enqueue from Log.create", () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    clearEnv(saved)
    process.env.VOLCENGINE_ACCESS_KEY_ID = "k"
    process.env.VOLCENGINE_ACCESS_KEY_SECRET = "s"
    process.env.VOLCENGINE_ENDPOINT = "tls-cn-beijing.volces.com"
    process.env.VOLCENGINE_REGION = "cn-beijing"
    process.env.OPENCODE_TLS_TOPIC_ID = "topic-1"
  })
  afterEach(() => restoreEnv(saved))

  test("Log.info enqueues a record with sessionID from withSession", async () => {
    const { LogTls } = await import(`../../src/util/log-tls?t=${Date.now()}`)
    const { Log } = await import(`../../src/util/log?t=${Date.now()}`)
    const log = Log.create({ service: "wiring-test" })
    Log.withSession("ses_42", () => {
      log.info("msg-under-test", { k: "v" })
    })
    expect(LogTls.bufferSize()).toBeGreaterThan(0)
    const last = LogTls.drainForTest()
    const rec = last.find((r: any) => r.message === "msg-under-test")
    expect(rec).toBeDefined()
    expect(rec.level).toBe("INFO")
    expect(rec.tags.sessionID).toBe("ses_42")
    expect(rec.tags.service).toBe("wiring-test")
    expect(rec.tags.k).toBe("v")
  })
})
```

Also add a test helper `drainForTest` to `log-tls.ts` in step 3.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/opencode && bun test test/util/log-tls.test.ts`
Expected: FAIL — `LogTls.drainForTest is not a function` and/or bufferSize is 0.

- [ ] **Step 3: Add `drainForTest` to `log-tls.ts` and enqueue from `log.ts` level methods**

In `packages/opencode/src/util/log-tls.ts`, add this export inside the namespace:

```ts
  export function drainForTest(): Record[] {
    const out = buffer
    buffer = []
    return out
  }
```

In `packages/opencode/src/util/log.ts`, add near the top imports:

```ts
import { LogTls } from "./log-tls"
```

Inside `create()`, replace each of the four level methods so they enqueue after calling `write`. Shape for `info` (repeat for `debug`, `warn`, `error` with matching level string):

```ts
      info(message?: any, extra?: Record<string, any>) {
        if (!shouldLog("INFO")) return
        const implicit = sessionStore.getStore()
        const merged = {
          ...(implicit?.sessionID ? { sessionID: implicit.sessionID } : {}),
          ...tags,
          ...extra,
        }
        write("INFO  " + build(message, extra))
        LogTls.enqueue({
          time: Date.now(),
          level: "INFO",
          message: message === undefined || message === null ? "" : String(message),
          tags: merged,
        })
      },
```

Apply the same pattern for `debug` (level `"DEBUG"`, prefix `"DEBUG "`), `warn` (level `"WARN"`, prefix `"WARN  "`), `error` (level `"ERROR"`, prefix `"ERROR "`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/opencode && bun test test/util/log-tls.test.ts test/util/log.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/opencode && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/util/log.ts packages/opencode/src/util/log-tls.ts packages/opencode/test/util/log-tls.test.ts
git commit -m "feat(log): enqueue every log line to LogTls sink with merged tags"
```

---

## Task 4: Batching, timer-based flush, overflow/warn throttling

Adds the actual in-memory batching behavior, still without any outbound HTTP (the flush function is pluggable; Task 5 plugs it into Volcengine).

**Files:**
- Modify: `packages/opencode/src/util/log-tls.ts`
- Test: `packages/opencode/test/util/log-tls.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `packages/opencode/test/util/log-tls.test.ts`:

```ts
describe("LogTls batching", () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    clearEnv(saved)
    process.env.VOLCENGINE_ACCESS_KEY_ID = "k"
    process.env.VOLCENGINE_ACCESS_KEY_SECRET = "s"
    process.env.VOLCENGINE_ENDPOINT = "tls-cn-beijing.volces.com"
    process.env.VOLCENGINE_REGION = "cn-beijing"
    process.env.OPENCODE_TLS_TOPIC_ID = "topic-1"
  })
  afterEach(() => restoreEnv(saved))

  test("flushes when batch threshold is reached", async () => {
    const mod = await import(`../../src/util/log-tls?t=${Date.now()}`)
    const { LogTls } = mod
    const batches: any[][] = []
    LogTls.setFlusherForTest(async (records: any[]) => {
      batches.push(records)
    })
    for (let i = 0; i < 100; i++) {
      LogTls.enqueue({ time: Date.now(), level: "INFO", message: `m${i}`, tags: {} })
    }
    // Threshold-triggered flushes are synchronous-schedule; await microtask drain
    await new Promise((r) => setImmediate(r))
    expect(batches.length).toBe(1)
    expect(batches[0].length).toBe(100)
  })

  test("drops oldest on overflow and reports via warnHook", async () => {
    const mod = await import(`../../src/util/log-tls?t=${Date.now()}`)
    const { LogTls } = mod
    const warns: string[] = []
    LogTls.setWarnHookForTest((msg: string) => warns.push(msg))
    LogTls.setFlusherForTest(async () => {}) // swallow
    // Force buffer to grow past cap without triggering threshold flushes.
    // We temporarily raise the threshold via test hook.
    LogTls.setFlushThresholdForTest(100_000)
    for (let i = 0; i < 5010; i++) {
      LogTls.enqueue({ time: Date.now(), level: "INFO", message: "overflow", tags: {} })
    }
    expect(LogTls.bufferSize()).toBe(5000)
    expect(warns.some((w) => w.includes("dropped"))).toBe(true)
  })

  test("flushNow flushes any buffered records", async () => {
    const mod = await import(`../../src/util/log-tls?t=${Date.now()}`)
    const { LogTls } = mod
    const batches: any[][] = []
    LogTls.setFlusherForTest(async (records: any[]) => {
      batches.push(records)
    })
    LogTls.enqueue({ time: Date.now(), level: "INFO", message: "m1", tags: {} })
    LogTls.enqueue({ time: Date.now(), level: "INFO", message: "m2", tags: {} })
    await LogTls.flushNow()
    expect(batches.length).toBe(1)
    expect(batches[0].length).toBe(2)
    expect(LogTls.bufferSize()).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/opencode && bun test test/util/log-tls.test.ts`
Expected: FAIL — `setFlusherForTest is not a function`, etc.

- [ ] **Step 3: Implement batching, overflow, test hooks**

Replace the body of `packages/opencode/src/util/log-tls.ts` with:

```ts
export namespace LogTls {
  export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR"

  export interface Record {
    time: number
    level: Level
    message: string
    tags: globalThis.Record<string, unknown>
  }

  interface Config {
    accessKeyId: string
    accessKeySecret: string
    endpoint: string
    region: string
    topicId: string
    source: string
  }

  export type Flusher = (records: Record[]) => Promise<void>

  let config: Config | undefined
  let enabled = false
  let buffer: Record[] = []
  let flushThreshold = 100
  const FLUSH_INTERVAL_MS = 2000
  let MAX_BUFFER = 5000
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = false
  let dropped = 0
  let failedBatches = 0
  let lastWarnAt = 0
  const WARN_INTERVAL_MS = 60_000

  let flusher: Flusher = async () => {} // replaced by real implementation in Task 5
  let warnHook: (msg: string) => void = (msg) => process.stderr.write("WARN  [LogTls] " + msg + "\n")

  function readConfig(): Config | undefined {
    if (process.env.OPENCODE_TLS_DISABLED === "1" || process.env.OPENCODE_TLS_DISABLED === "true") return undefined
    const ak = process.env.VOLCENGINE_ACCESS_KEY_ID
    const sk = process.env.VOLCENGINE_ACCESS_KEY_SECRET
    const endpoint = process.env.VOLCENGINE_ENDPOINT
    const region = process.env.VOLCENGINE_REGION
    const topicId = process.env.OPENCODE_TLS_TOPIC_ID
    if (!ak || !sk || !endpoint || !region || !topicId) return undefined
    return {
      accessKeyId: ak,
      accessKeySecret: sk,
      endpoint,
      region,
      topicId,
      source: process.env.OPENCODE_TLS_SOURCE ?? "opencode",
    }
  }

  function throttledWarn(msg: string) {
    const now = Date.now()
    if (now - lastWarnAt < WARN_INTERVAL_MS) return
    lastWarnAt = now
    warnHook(msg)
  }

  function startTimer() {
    if (timer) return
    timer = setInterval(() => {
      void flushNow()
    }, FLUSH_INTERVAL_MS)
    // Don't block process exit solely on this timer.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      ;(timer as unknown as { unref(): void }).unref()
    }
  }

  function init() {
    config = readConfig()
    enabled = config !== undefined
    if (enabled) startTimer()
  }

  init()

  export function isEnabled(): boolean {
    return enabled
  }

  export function config_(): Config | undefined {
    return config
  }

  export function bufferSize(): number {
    return buffer.length
  }

  export function droppedCount(): number {
    return dropped
  }

  export function failedBatchesCount(): number {
    return failedBatches
  }

  export function enqueue(record: Record): void {
    if (!enabled) return
    if (buffer.length >= MAX_BUFFER) {
      buffer.shift()
      dropped++
      throttledWarn(`log buffer full — dropped ${dropped} records (PutLogs failed batches: ${failedBatches})`)
    }
    buffer.push(record)
    if (buffer.length >= flushThreshold && !inFlight) {
      queueMicrotask(() => void flushNow())
    }
  }

  export async function flushNow(): Promise<void> {
    if (!enabled || inFlight || buffer.length === 0) return
    inFlight = true
    const batch = buffer
    buffer = []
    try {
      await flusher(batch)
    } catch (err) {
      failedBatches++
      throttledWarn(`PutLogs failed: ${(err as Error)?.message ?? String(err)} (failed batches: ${failedBatches})`)
    } finally {
      inFlight = false
    }
  }

  export async function shutdown(timeoutMs = 2000): Promise<void> {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    if (!enabled) return
    await Promise.race([flushNow(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
  }

  // --- test hooks ---

  export function setFlusherForTest(fn: Flusher): void {
    flusher = fn
    enabled = true
  }

  export function setWarnHookForTest(fn: (msg: string) => void): void {
    warnHook = fn
  }

  export function setFlushThresholdForTest(n: number): void {
    flushThreshold = n
  }

  export function drainForTest(): Record[] {
    const out = buffer
    buffer = []
    return out
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/opencode && bun test test/util/log-tls.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/opencode && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/util/log-tls.ts packages/opencode/test/util/log-tls.test.ts
git commit -m "feat(log): add LogTls batching, overflow handling, flushNow, shutdown"
```

---

## Task 5: Plug Volcengine `PutLogs` flusher in

**Files:**
- Modify: `packages/opencode/package.json`
- Modify: `packages/opencode/src/util/log-tls.ts`

- [ ] **Step 1: Add the dependency**

In `packages/opencode/package.json`, add to `"dependencies"` (alphabetical order):

```json
"@volcengine/openapi": "^1.2.2",
```

Run: `cd packages/opencode && bun install`
Expected: lockfile updates, install succeeds.

- [ ] **Step 2: Add the real flusher**

In `packages/opencode/src/util/log-tls.ts`, add this helper near the bottom of the namespace (but above `--- test hooks ---`):

```ts
  async function volcengineFlusher(records: Record[]): Promise<void> {
    if (!config) return
    const { tlsOpenapi } = await import("@volcengine/openapi")
    // Configure the default service with env-derived credentials. SDK reads env vars directly.
    process.env.VOLCENGINE_ACCESS_KEY_ID = config.accessKeyId
    process.env.VOLCENGINE_ACCESS_KEY_SECRET = config.accessKeySecret
    process.env.VOLCENGINE_ENDPOINT = config.endpoint
    process.env.VOLCENGINE_REGION = config.region
    const svc = tlsOpenapi.defaultService
    const logBuffer = await tlsOpenapi.TlsService.objToProtoBuffer({
      LogGroups: [
        {
          Source: config.source,
          Logs: records.map((r) => ({
            Time: Math.floor(r.time / 1000),
            Contents: [
              { Key: "level", Value: r.level },
              { Key: "message", Value: r.message },
              ...Object.entries(r.tags).map(([k, v]) => ({
                Key: k,
                Value: typeof v === "string" ? v : JSON.stringify(v),
              })),
            ],
          })),
        },
      ],
    })
    await svc.PutLogs({
      TopicId: config.topicId,
      CompressType: "lz4",
      LogGroupList: logBuffer,
    })
  }
```

Replace the `let flusher: Flusher = async () => {}` initializer so that it defaults to the real flusher when enabled. Change:

```ts
  let flusher: Flusher = async () => {} // replaced by real implementation in Task 5
```

to:

```ts
  let flusher: Flusher = (records) => volcengineFlusher(records)
```

- [ ] **Step 3: Confirm existing tests still pass**

The tests use `setFlusherForTest` to override the real flusher, so they should continue to pass.

Run: `cd packages/opencode && bun test test/util/log-tls.test.ts`
Expected: PASS, all tests.

- [ ] **Step 4: Run typecheck**

Run: `cd packages/opencode && bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/package.json packages/opencode/src/util/log-tls.ts bun.lock
git commit -m "feat(log): add Volcengine PutLogs flusher to LogTls"
```

(If your repo uses `bun.lockb` instead of `bun.lock`, substitute the correct lockfile name.)

---

## Task 6: Wrap server session routes in `Log.withSession` via middleware

**Files:**
- Modify: `packages/opencode/src/server/server.ts`

- [ ] **Step 1: Read the current middleware chain**

Run: `cd packages/opencode && bun x biome format src/server/server.ts || cat src/server/server.ts | head -160`
Or open `packages/opencode/src/server/server.ts`. Identify where routes are mounted (look for `app.route(...)` / `.route("/session", ...)`).

- [ ] **Step 2: Add a Hono middleware that wraps request handling in `Log.withSession` when a `sessionID` path param is present**

In `packages/opencode/src/server/server.ts`, near the other `.use(...)` middlewares in both `ControlPlaneRoutes` and `InstanceRoutes` (check `instance.ts` too), add:

```ts
      .use(async (c, next) => {
        const sessionID =
          (c.req.param("sessionID") as string | undefined) ??
          (c.req.param("sid") as string | undefined)
        if (!sessionID) return next()
        return Log.withSession(sessionID, () => next())
      })
```

Place this middleware **after** the auth middleware but **before** the `cors` middleware / request logger timer, so downstream handlers see the session context. Hono param lookup in a generic `.use(...)` middleware only works on nested route groups — so instead of server-root registration, register it inside the session route file. Edit `packages/opencode/src/server/routes/session.ts`: find the top-level `const app = new Hono()` (or equivalent router) and add as the very first `.use()`:

```ts
import { Log } from "../../util/log"

app.use("/:sessionID/*", async (c, next) => {
  const sessionID = c.req.param("sessionID")
  if (!sessionID) return next()
  return Log.withSession(sessionID, () => next())
})
app.use("/:sessionID", async (c, next) => {
  const sessionID = c.req.param("sessionID")
  if (!sessionID) return next()
  return Log.withSession(sessionID, () => next())
})
```

Similarly, in `packages/opencode/src/server/routes/event.ts` and `packages/opencode/src/server/routes/global.ts` (where sessionID is a query parameter on `/event` / `/global/sync-event` — see commit 06462ee56), wrap the inner handler:

```ts
// inside the route body, replace
//   return handler(...)
// with:
const sessionID = c.req.query("sessionID")
if (sessionID) {
  return Log.withSession(sessionID, () => handler(...))
}
return handler(...)
```

Locate the exact lines by searching: `grep -n "sessionID" packages/opencode/src/server/routes/event.ts packages/opencode/src/server/routes/global.ts`.

- [ ] **Step 3: Manual verification**

Run: `cd packages/opencode && bun run dev` in one terminal. Trigger a session-scoped request (e.g. via TUI or `curl` to `/session/<id>/...`). Then:

```bash
grep "sessionID=" ~/.local/share/opencode/log/dev.log | tail -20
```

Expected: log lines emitted during the request contain `sessionID=<that id>`.

- [ ] **Step 4: Run typecheck**

Run: `cd packages/opencode && bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the full test suite**

Run: `cd packages/opencode && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/server/routes/session.ts packages/opencode/src/server/routes/event.ts packages/opencode/src/server/routes/global.ts
git commit -m "feat(server): wrap session-scoped routes in Log.withSession"
```

---

## Task 7: Wrap CLI `run` and TUI worker in `Log.withSession`

**Files:**
- Modify: `packages/opencode/src/cli/cmd/run.ts`
- Modify: `packages/opencode/src/cli/cmd/tui/worker.ts`

- [ ] **Step 1: Identify the sessionID in `run.ts`**

Search: `grep -n "sessionID\|Session\.create\|session\.id" packages/opencode/src/cli/cmd/run.ts`

Find the point where a session is created/loaded (look for `Session.create({...})` or `client.session.create(...)` returning an object with `id`). Immediately after you have a concrete `sessionID` and before the prompt loop begins, wrap the remainder:

```ts
import { Log } from "../../util/log"
// ...
await Log.withSession(sessionID, async () => {
  // existing body: prompt loop, tool dispatch, etc.
})
```

If the body is not easily bracketed, extract it into a local `async function body()` and call:

```ts
return Log.withSession(sessionID, () => body())
```

- [ ] **Step 2: Same treatment in `tui/worker.ts`**

Search: `grep -n "sessionID" packages/opencode/src/cli/cmd/tui/worker.ts`

If the worker handles one session at a time, wrap the event loop body once a session is acquired. If it multiplexes, wrap each per-message handler:

```ts
return Log.withSession(msg.sessionID, () => handle(msg))
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/opencode && bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run: `cd packages/opencode && bun run dev run "hello world"` (or equivalent). Check `~/.local/share/opencode/log/dev.log` — lines emitted after session creation should carry `sessionID=…`.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/cli/cmd/run.ts packages/opencode/src/cli/cmd/tui/worker.ts
git commit -m "feat(cli): wrap run and tui worker bodies in Log.withSession"
```

---

## Task 8: Wrap per-session projector callbacks

**Files:**
- Modify: `packages/opencode/src/server/projectors.ts`

- [ ] **Step 1: Locate the projector dispatch loop**

Run: `grep -n "sessionID" packages/opencode/src/server/projectors.ts`

Identify the place where an event is routed to a handler and the event payload has a `sessionID` field.

- [ ] **Step 2: Wrap the handler invocation**

At the point of dispatch, replace:

```ts
await handler(event)
```

with:

```ts
const sessionID = (event as any)?.sessionID ?? (event as any)?.properties?.sessionID
if (sessionID) {
  await Log.withSession(sessionID, () => handler(event))
} else {
  await handler(event)
}
```

Add the import if not present: `import { Log } from "../util/log"`.

- [ ] **Step 3: Run typecheck**

Run: `cd packages/opencode && bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the test suite**

Run: `cd packages/opencode && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/server/projectors.ts
git commit -m "feat(server): wrap session-keyed projector handlers in Log.withSession"
```

---

## Task 9: Shutdown flush wiring and init-time status log

**Files:**
- Modify: `packages/opencode/src/util/log.ts`
- Modify: `packages/opencode/src/index.ts`

- [ ] **Step 1: Emit a one-shot status line at init**

In `packages/opencode/src/util/log.ts`, inside `export async function init(options: Options)`, at the end (after the `write = async ...` assignment), add:

```ts
    if (LogTls.isEnabled()) {
      Default.info("log-tls", { status: "enabled", endpoint: process.env.VOLCENGINE_ENDPOINT, topic: process.env.OPENCODE_TLS_TOPIC_ID })
    } else if (process.env.OPENCODE_TLS_DISABLED === "1" || process.env.OPENCODE_TLS_DISABLED === "true") {
      Default.info("log-tls", { status: "disabled-by-env" })
    } else if (process.env.VOLCENGINE_ACCESS_KEY_ID || process.env.OPENCODE_TLS_TOPIC_ID) {
      Default.info("log-tls", { status: "disabled-missing-env" })
    }
```

- [ ] **Step 2: Register shutdown hooks**

In `packages/opencode/src/index.ts`, find the bootstrap section (near the top, around `Log.init({...})` at line 90). Immediately after `Log.init(...)` completes, add:

```ts
import { LogTls } from "./util/log-tls"
// ...
const shutdown = async () => {
  try {
    await LogTls.shutdown(2000)
  } catch {}
}
process.on("beforeExit", shutdown)
process.on("SIGINT", async () => {
  await shutdown()
  process.exit(130)
})
process.on("SIGTERM", async () => {
  await shutdown()
  process.exit(143)
})
```

Check that an existing signal handler does not already exist (grep `SIGINT\|SIGTERM`). If so, append the flush call inside the existing handler instead of adding a second listener.

- [ ] **Step 3: Run typecheck**

Run: `cd packages/opencode && bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run (with valid TLS env set):
```bash
cd packages/opencode && bun run dev run "hello"
```
Ctrl-C mid-run; verify there's no hang >2s. Check TLS console that recent records made it in.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/util/log.ts packages/opencode/src/index.ts
git commit -m "feat(log): emit TLS sink status at init and flush on shutdown signals"
```

---

## Task 10: README / docs update

**Files:**
- Modify: `packages/opencode/README.md` (or wherever env vars are documented — check first)

- [ ] **Step 1: Locate environment docs**

Run: `grep -rn "VOLCENGINE\|OPENCODE_" packages/opencode/README.md docs/ 2>/dev/null || echo "no existing env docs"`

If no existing docs file, add a short section to `packages/opencode/README.md` under a "Logging" heading:

```markdown
## Logging

Logs are written to stderr (or a rotated file under the opencode log directory). When handling a session, each log line is automatically tagged `sessionID=<id>`.

### Shipping to Volcengine TLS

Set all of the following environment variables and every log line will be shipped to a TLS log topic (in addition to the local sink):

- `VOLCENGINE_ACCESS_KEY_ID`
- `VOLCENGINE_ACCESS_KEY_SECRET`
- `VOLCENGINE_ENDPOINT` (e.g. `tls-cn-beijing.volces.com`)
- `VOLCENGINE_REGION` (e.g. `cn-beijing`)
- `OPENCODE_TLS_TOPIC_ID`

Optional:
- `OPENCODE_TLS_SOURCE` (defaults to `opencode`)
- `OPENCODE_TLS_DISABLED=1` — disables the sink even when the above are set (handy for local development with prod credentials in your shell).

Delivery is best-effort, batched (100 records / 2s), and bounded at 5000 in-memory records. On shutdown, opencode attempts one final flush with a 2-second timeout.
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/README.md
git commit -m "docs: document session-aware logging and Volcengine TLS sink"
```

---

## Final Verification

- [ ] **Run full test suite**

Run: `cd packages/opencode && bun test`
Expected: all tests pass.

- [ ] **Run typecheck**

Run: `cd packages/opencode && bun run typecheck`
Expected: no errors.

- [ ] **Smoke test: disabled path**

Run: `unset VOLCENGINE_ACCESS_KEY_ID && cd packages/opencode && bun run dev run "hi"`
Expected: opencode works normally, no TLS traffic, log file contains `sessionID=…` on session-scoped lines and a one-shot `log-tls status=disabled-missing-env` at startup (if any VOLCENGINE var is set) or no log-tls message.

- [ ] **Smoke test: enabled path**

Export all TLS env vars pointing at a sandbox topic, run an opencode session, then search the TLS console for records with the session's ID. Verify `sessionID`, `service`, `level` appear as fields.
