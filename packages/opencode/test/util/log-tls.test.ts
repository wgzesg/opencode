import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { LogTls as LogTlsStatic } from "../../src/util/log-tls"
import { Log } from "../../src/util/log"

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
    const { LogTls } = await import(`../../src/util/log-tls?t=${Date.now()}`)
    expect(LogTls.isEnabled()).toBe(false)
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

  test("Log.info enqueues a record with sessionID from withSession", () => {
    LogTlsStatic.reinitForTest()
    LogTlsStatic.drainForTest()
    const log = Log.create({ service: "wiring-test" })
    Log.withSession("ses_42", () => {
      log.info("msg-under-test", { k: "v" })
    })
    const records = LogTlsStatic.drainForTest()
    const rec = records.find((r: any) => r.message === "msg-under-test")
    expect(rec).toBeDefined()
    if (!rec) return
    expect(rec.level).toBe("INFO")
    expect(rec.tags.sessionID).toBe("ses_42")
    expect(rec.tags.service).toBe("wiring-test")
    expect(rec.tags.k).toBe("v")
  })

  test("Log.error enqueues with level=ERROR", () => {
    LogTlsStatic.reinitForTest()
    LogTlsStatic.drainForTest()
    const log = Log.create({ service: "wiring-test-err" })
    log.error("boom")
    const records = LogTlsStatic.drainForTest()
    const rec = records.find((r: any) => r.message === "boom")
    expect(rec?.level).toBe("ERROR")
  })
})

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
    const { LogTls } = await import("../../src/util/log-tls")
    LogTls.reinitForTest()
    LogTls.drainForTest()
    const batches: any[][] = []
    LogTls.setFlusherForTest(async (records: any[]) => {
      batches.push(records)
    })
    for (let i = 0; i < 100; i++) {
      LogTls.enqueue({ time: Date.now(), level: "INFO", message: `m${i}`, tags: {} })
    }
    await new Promise((r) => setImmediate(r))
    expect(batches.length).toBe(1)
    expect(batches[0].length).toBe(100)
  })

  test("drops oldest on overflow and reports via warnHook", async () => {
    const { LogTls } = await import("../../src/util/log-tls")
    LogTls.reinitForTest()
    LogTls.drainForTest()
    const warns: string[] = []
    LogTls.setWarnHookForTest((msg: string) => warns.push(msg))
    LogTls.setFlusherForTest(async () => {})
    LogTls.setFlushThresholdForTest(100_000)
    for (let i = 0; i < 5010; i++) {
      LogTls.enqueue({ time: Date.now(), level: "INFO", message: "overflow", tags: {} })
    }
    expect(LogTls.bufferSize()).toBe(5000)
    expect(warns.some((w) => w.includes("dropped"))).toBe(true)
    LogTls.setFlushThresholdForTest(100)
  })

  test("flushNow flushes any buffered records", async () => {
    const { LogTls } = await import("../../src/util/log-tls")
    LogTls.reinitForTest()
    LogTls.drainForTest()
    const batches: any[][] = []
    LogTls.setFlusherForTest(async (records: any[]) => {
      batches.push(records)
    })
    LogTls.setFlushThresholdForTest(100_000)
    LogTls.enqueue({ time: Date.now(), level: "INFO", message: "m1", tags: {} })
    LogTls.enqueue({ time: Date.now(), level: "INFO", message: "m2", tags: {} })
    await LogTls.flushNow()
    expect(batches.length).toBe(1)
    expect(batches[0].length).toBe(2)
    expect(LogTls.bufferSize()).toBe(0)
    LogTls.setFlushThresholdForTest(100)
  })
})
