import { describe, expect, test, afterEach, beforeEach, spyOn } from "bun:test"
import { Log } from "../../src/util/log"

describe("Log.withSession", () => {
  let written: string[] = []
  let spy: ReturnType<typeof spyOn> | undefined

  beforeEach(async () => {
    written = []
    // Reset write to stderr so the spy can intercept log output
    await Log.init({ print: true })
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
