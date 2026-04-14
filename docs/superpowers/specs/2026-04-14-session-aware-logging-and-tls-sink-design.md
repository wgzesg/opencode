# Session-Aware Logging and Volcengine TLS Sink

**Date:** 2026-04-14
**Status:** Draft
**Scope:** `packages/opencode`

## Goal

Two related improvements to opencode's logger:

1. **Session-aware logs.** Any log line emitted while handling a particular session should carry that session's ID, automatically and without changing call sites.
2. **Cloud log shipping.** In addition to stderr/file, ship every log line to a Volcengine TLS topic so logs from production-like deployments are searchable centrally.

Both features are opt-in via environment variables; with no env configuration opencode behaves exactly as it does today.

## Non-Goals

- No replacement of the existing stderr/file sinks. TLS is purely additive.
- No general pluggable-sink abstraction. One additional sink (TLS) is the only new sink.
- No support for unauthenticated WebTracking (`@volcengine/tls-js-sdk`). It requires enabling anonymous public write on the topic, which is unsafe for engineering logs.
- No durable/on-disk queue for undelivered records. Best-effort batching only.
- No structured-logging refactor. The existing prefix-string format stays.

## Background

`packages/opencode/src/util/log.ts` exposes `Log.create({ tag: value, ... })`, which returns a `Logger` whose lines are formatted as `<ISO time> +<diff>ms key=value ... message`. A single module-level `write` function is the sink (stderr or a rotated file under `Global.Path.log`, chosen at `Log.init`).

Two existing affordances make this design cheap:

- The format function `build()` already merges per-call `extra` into the logger's `tags` before composing the prefix line — so any tag we inject upstream automatically appears in the output.
- `tag()` and `clone()` already exist for callers that want a derived logger.

What's missing is (a) a way to inject a tag without every call site cooperating, and (b) a second sink.

## Design

### 1. Session-ID propagation via `AsyncLocalStorage`

Inside `packages/opencode/src/util/log.ts`:

```ts
import { AsyncLocalStorage } from "async_hooks"

const sessionStore = new AsyncLocalStorage<{ sessionID: string }>()

export function withSession<T>(sessionID: string, fn: () => T): T {
  return sessionStore.run({ sessionID }, fn)
}

export function currentSessionID(): string | undefined {
  return sessionStore.getStore()?.sessionID
}
```

`build()` is updated so that the implicit session tag is merged in at format time:

```ts
const sessionID = sessionStore.getStore()?.sessionID
const merged = { ...(sessionID ? { sessionID } : {}), ...tags, ...extra }
```

(Per-call `extra` and explicit `tags` win over the implicit value, so callers can still override.)

The cached-by-service logger map stays as-is; the AsyncLocalStorage lookup is per-call, so the same cached `Logger` correctly emits different `sessionID`s in different async contexts.

**Wrap sites.** We wrap the entrypoints that own a session in `Log.withSession(sessionID, fn)`. Concretely (paths to confirm during plan-writing):

- HTTP handlers in the server package that operate on a `:sessionID` path parameter — wrap the handler body.
- The `/event` and `/global/sync-event` handlers when filtered by sessionID (already plumbed in commit 06462ee56).
- The CLI `run` command once a session is created/loaded.
- The TUI session loop.
- Background projectors/queue workers that process per-session messages.

These are the only changes needed; downstream code (tools, providers, message store, etc.) needs zero modification.

### 2. TLS sink module

New file `packages/opencode/src/util/log-tls.ts`:

```ts
export namespace LogTls {
  export interface Record {
    time: number       // ms since epoch
    level: "DEBUG" | "INFO" | "WARN" | "ERROR"
    message: string
    tags: Record<string, unknown>  // includes sessionID, service, etc.
  }

  export function enqueue(record: Record): void
  export function shutdown(): Promise<void>
}
```

**Configuration.** On first `enqueue` (lazy init), read env:

| Variable | Purpose |
|---|---|
| `VOLCENGINE_ACCESS_KEY_ID` | required |
| `VOLCENGINE_ACCESS_KEY_SECRET` | required |
| `VOLCENGINE_ENDPOINT` | required, e.g. `tls-cn-beijing.volces.com` |
| `VOLCENGINE_REGION` | required, e.g. `cn-beijing` |
| `OPENCODE_TLS_TOPIC_ID` | required, target topic |
| `OPENCODE_TLS_SOURCE` | optional, default `os.hostname()` |
| `OPENCODE_TLS_DISABLED` | if set to `1`/`true`, sink is no-op even when other vars present |

If any required var is missing, `enqueue` becomes a no-op for the lifetime of the process. We log a single INFO line at init describing whether the sink is on or off (and which env var was missing if off), so misconfiguration is discoverable.

**Buffering.** In-memory ring buffer, capacity 5000 records.

- Flush trigger: ≥100 records buffered, OR every 2000 ms via `setInterval` (unrefed so it doesn't keep the process alive), OR explicit `shutdown()`.
- Each flush takes the current buffer, packages it via `tlsOpenapi.TlsService.objToProtoBuffer({ LogGroups: [...] })`, and calls `tlsOpenapiService.PutLogs({ TopicId, CompressType: 'lz4', LogGroupList })`.
- One `LogGroup` per flush; each `Record` becomes one `Log` with `Time` (seconds) and `Contents = [{Key, Value}, ...]` derived from `tags` plus a synthetic `level` and `message` field.

**Backpressure & failure.**

- On buffer full: drop oldest record, increment `dropped` counter, emit at most one stderr WARN per minute reporting the count.
- On `PutLogs` failure: drop the batch, increment `failedBatches`, emit at most one stderr WARN per minute. Never re-enqueue (avoids loops where a failing TLS write generates more log records that try to ship to TLS).

**Shutdown.** `Log.init` registers `process.on("beforeExit" | "SIGINT" | "SIGTERM", () => LogTls.shutdown())`. `shutdown()` clears the timer and performs one final best-effort flush with a 2-second timeout.

### 3. Wiring `Log.create()` to the TLS sink

Inside the level methods in `log.ts`, after the existing `write(...)` call, also call `LogTls.enqueue(...)` with structured fields:

```ts
info(message?: any, extra?: Record<string, any>) {
  if (!shouldLog("INFO")) return
  const sessionID = sessionStore.getStore()?.sessionID
  const merged = { ...(sessionID ? { sessionID } : {}), ...tags, ...extra }
  write("INFO  " + build(message, extra))
  LogTls.enqueue({ time: Date.now(), level: "INFO", message: String(message ?? ""), tags: merged })
}
```

(Identical pattern for `debug`, `warn`, `error`.) The TLS path receives structured tags, so `sessionID`, `service`, etc. become first-class indexable fields in TLS rather than substrings of the log line.

### 4. Dependency

Add `@volcengine/openapi` to `packages/opencode/package.json` `dependencies`. Lazy-`require` it inside `log-tls.ts`, so a missing module at runtime degrades to "sink off" rather than crashing opencode.

### 5. File layout

```
packages/opencode/src/util/
  log.ts          # AsyncLocalStorage + withSession added; level methods enqueue to TLS
  log-tls.ts      # NEW — env config, ring buffer, flush, shutdown
```

Wrap-site edits: ~3–6 small changes in the server, CLI, TUI, and projector entry points.

## Failure Modes Summary

| Condition | Behavior |
|---|---|
| TLS env vars absent | Sink off, single INFO at init. opencode runs normally. |
| `OPENCODE_TLS_DISABLED=1` | Sink off regardless of other env. |
| `@volcengine/openapi` not installed | Sink off, single WARN at init. |
| `PutLogs` HTTP error | Batch dropped, throttled stderr WARN. No retry. |
| Buffer overflow (>5000 records) | Oldest dropped, throttled stderr WARN. |
| Process exits cleanly | `beforeExit` flush attempts final batch (2s timeout). |
| Process killed (`SIGKILL`) | In-flight buffer lost — accepted. |

## Testing

- **Unit:** `withSession` injects `sessionID` into emitted lines; nested `withSession` overrides; calls outside a wrap are tag-free.
- **Unit:** `LogTls.enqueue` is a no-op when env is missing.
- **Unit:** ring buffer drops oldest on overflow, throttles WARN.
- **Integration:** mock `tlsOpenapiService.PutLogs`, assert that 100 enqueues trigger a flush and that a 2s tick flushes a partial buffer.
- **Manual:** point at a sandbox topic, run `opencode run`, verify session-tagged lines arrive in TLS console.

## Open Questions

None.
