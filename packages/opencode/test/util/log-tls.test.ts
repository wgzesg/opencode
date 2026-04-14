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
