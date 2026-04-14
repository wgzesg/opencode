import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { TelemetryPreflight } from "../../src/telemetry/preflight-config"

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "preflight-cfg-"))
}

describe("TelemetryPreflight", () => {
  const savedEnv: Record<string, string | undefined> = {}
  const keys = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME"]
  let tmp: string

  beforeEach(() => {
    for (const k of keys) savedEnv[k] = process.env[k]
    tmp = makeTempDir()
    // Sandbox all lookup roots into the tmp dir so tests don't read the real ~/.config.
    process.env.HOME = tmp
    process.env.XDG_CONFIG_HOME = path.join(tmp, ".config")
    delete process.env.OPENCODE_CONFIG
    delete process.env.OPENCODE_CONFIG_DIR
    TelemetryPreflight.resetForTest()
  })

  afterEach(() => {
    for (const k of keys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    TelemetryPreflight.resetForTest()
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
  })

  test("returns empty when no config found", () => {
    const loaded = TelemetryPreflight.load(tmp)
    expect(loaded.logs).toBeUndefined()
    expect(loaded.traces).toBeUndefined()
  })

  test("reads telemetry block from project-root opencode.json", () => {
    fs.writeFileSync(
      path.join(tmp, "opencode.json"),
      JSON.stringify({
        telemetry: {
          logs: {
            provider: "volcengine.tls",
            accessKeyId: "ak-1",
            accessKeySecret: "sk-1",
            endpoint: "tls-cn-beijing.volces.com",
            region: "cn-beijing",
            topicId: "topic-xyz",
          },
          traces: {
            enabled: true,
            endpoint: "http://localhost:4318",
            sampleRatio: 0.5,
          },
        },
      }),
    )
    const loaded = TelemetryPreflight.load(tmp)
    expect(loaded.logs?.accessKeyId).toBe("ak-1")
    expect(loaded.logs?.topicId).toBe("topic-xyz")
    expect(loaded.traces?.enabled).toBe(true)
    expect(loaded.traces?.sampleRatio).toBe(0.5)
  })

  test("project config wins over xdg config", () => {
    const xdg = path.join(tmp, ".config", "opencode")
    fs.mkdirSync(xdg, { recursive: true })
    fs.writeFileSync(
      path.join(xdg, "opencode.json"),
      JSON.stringify({ telemetry: { logs: { topicId: "global-topic", accessKeyId: "ak-global" } } }),
    )
    fs.writeFileSync(
      path.join(tmp, "opencode.json"),
      JSON.stringify({ telemetry: { logs: { topicId: "project-topic" } } }),
    )
    const loaded = TelemetryPreflight.load(tmp)
    expect(loaded.logs?.topicId).toBe("project-topic")
    // project doesn't override accessKeyId so we keep the global value
    expect(loaded.logs?.accessKeyId).toBe("ak-global")
  })

  test("tolerates invalid JSON gracefully", () => {
    fs.writeFileSync(path.join(tmp, "opencode.json"), "{ not json")
    const loaded = TelemetryPreflight.load(tmp)
    // Invalid file is skipped; nothing found.
    expect(loaded.logs).toBeUndefined()
    expect(loaded.traces).toBeUndefined()
  })

  test("honors OPENCODE_CONFIG when set", () => {
    const explicit = path.join(tmp, "explicit.json")
    fs.writeFileSync(
      explicit,
      JSON.stringify({ telemetry: { traces: { enabled: true, serviceName: "from-explicit" } } }),
    )
    process.env.OPENCODE_CONFIG = explicit
    TelemetryPreflight.resetForTest()
    const loaded = TelemetryPreflight.load(tmp)
    expect(loaded.traces?.serviceName).toBe("from-explicit")
  })
})
