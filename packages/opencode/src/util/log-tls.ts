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
  const MAX_BUFFER = 5000
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = false
  let dropped = 0
  let failedBatches = 0
  let lastWarnAt = 0
  const WARN_INTERVAL_MS = 60_000

  async function volcengineFlusher(records: Record[]): Promise<void> {
    if (!config) return
    const { tlsOpenapi } = await import("@volcengine/openapi")
    const svc = tlsOpenapi.defaultService
    svc.setAccessKeyId(config.accessKeyId)
    svc.setSecretKey(config.accessKeySecret)
    svc.setHost(config.endpoint.replace(/^https?:\/\//, ""))
    svc.setRegion(config.region)
    svc.setProtocol("https:")
    const logBuffer = await tlsOpenapi.TlsService.objToProtoBuffer({
      LogGroups: [
        {
          Source: config.source,
          LogTags: [],
          FileName: "",
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
      LogGroupList: Buffer.from(logBuffer),
    })
  }

  let flusher: Flusher = (records) => volcengineFlusher(records)
  let warnHook: (msg: string) => void = (msg) => process.stderr.write("WARN  [LogTls] " + msg + "\n")

  function readConfig(): Config | undefined {
    if (process.env.OPENCODE_TLS_DISABLED === "1" || process.env.OPENCODE_TLS_DISABLED === "true") return undefined
    // Preflight config (opencode.json telemetry.logs) wins over env.
    let fromFile: import("../telemetry/preflight-config").TelemetryPreflight.LogsConfig | undefined
    try {
      const { TelemetryPreflight } = require("../telemetry/preflight-config") as typeof import("../telemetry/preflight-config")
      fromFile = TelemetryPreflight.load().logs
    } catch {}
    if (fromFile?.enabled === false) return undefined
    if (fromFile?.provider && fromFile.provider !== "volcengine.tls") return undefined
    const ak = fromFile?.accessKeyId ?? process.env.VOLCENGINE_ACCESS_KEY_ID
    const sk = fromFile?.accessKeySecret ?? process.env.VOLCENGINE_ACCESS_KEY_SECRET
    const endpoint = fromFile?.endpoint ?? process.env.VOLCENGINE_ENDPOINT
    const region = fromFile?.region ?? process.env.VOLCENGINE_REGION
    const topicId = fromFile?.topicId ?? process.env.OPENCODE_TLS_TOPIC_ID
    if (!ak || !sk || !endpoint || !region || !topicId) return undefined
    return {
      accessKeyId: ak,
      accessKeySecret: sk,
      endpoint,
      region,
      topicId,
      source: fromFile?.source ?? process.env.OPENCODE_TLS_SOURCE ?? "opencode",
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
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      ;(timer as unknown as { unref(): void }).unref()
    }
  }

  function init() {
    config = readConfig()
    enabled = config !== undefined
    buffer = []
    inFlight = false
    dropped = 0
    failedBatches = 0
    lastWarnAt = 0
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    if (enabled) startTimer()
  }

  init()

  export function isEnabled(): boolean {
    return enabled
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
      const msg = (err as Error)?.message ?? String(err)
      const stack = (err as Error)?.stack
      if (failedBatches === 1) {
        process.stderr.write(`WARN  [LogTls] first PutLogs failure: ${msg}\n${stack ?? ""}\n`)
      }
      throttledWarn(`PutLogs failed: ${msg} (failed batches: ${failedBatches})`)
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

  export function reinitForTest(): void {
    init()
  }

  // Test hooks
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
