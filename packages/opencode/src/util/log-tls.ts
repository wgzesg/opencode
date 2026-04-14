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
    buffer = []
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
    buffer = []
  }

  /**
   * Re-runs init() so tests can observe current env values.
   * Used when the dynamic-import cache-bust trick (`?t=...`) is not supported.
   */
  export function reinitForTest(): void {
    init()
  }

  /**
   * Test-only helper: returns and clears the buffer.
   */
  export function drainForTest(): Record[] {
    const out = buffer
    buffer = []
    return out
  }
}
