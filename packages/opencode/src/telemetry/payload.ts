import type { Span } from "@opentelemetry/api"

/**
 * Maximum bytes per recorded payload attribute. OTel exporters/backends often
 * truncate very long string attributes (TLS in particular limits attribute
 * size); keeping this bounded also avoids ballooning span size.
 *
 * Override with `OPENCODE_TRACE_PAYLOAD_MAX` (bytes). Set
 * `OPENCODE_TRACE_PAYLOAD_DISABLED=1` to omit input/output capture entirely.
 */
const DEFAULT_MAX = 8192

function maxBytes(): number {
  const raw = Number(process.env["OPENCODE_TRACE_PAYLOAD_MAX"] ?? "")
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX
}

function disabled(): boolean {
  return process.env["OPENCODE_TRACE_PAYLOAD_DISABLED"] === "1"
}

/** Replace base64/binary image parts with a small descriptor so prompts stay
 *  loggable. Operates on AI SDK ModelMessage[]-shaped arrays. */
export function redactMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages
  return messages.map((m: any) => {
    if (!m || typeof m !== "object") return m
    if (typeof m.content === "string") return m
    if (!Array.isArray(m.content)) return m
    return {
      ...m,
      content: m.content.map((part: any) => {
        if (!part || typeof part !== "object") return part
        if (part.type === "image" || part.type === "image_url" || part.type === "file") {
          const data = part.image ?? part.image_url ?? part.data ?? part.file
          let bytes = 0
          let mediaType = part.mediaType ?? part.mimeType ?? "unknown"
          if (typeof data === "string") {
            // base64 or data URL
            bytes = data.length
          } else if (data && typeof data === "object") {
            if (typeof data.url === "string") return { type: part.type, url: truncate(data.url, 256) }
            if (data instanceof Uint8Array) bytes = data.byteLength
          }
          return { type: part.type, mediaType, bytes }
        }
        return part
      }),
    }
  })
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `…[truncated ${s.length - max} chars]`
}

function stringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Set a payload attribute on a span with truncation + size telemetry.
 *  Writes `<key>`, `<key>.size_bytes`, and `<key>.truncated` (if cut). */
export function setPayload(span: Span, key: string, value: unknown): void {
  if (disabled()) return
  const max = maxBytes()
  const text = stringify(value)
  const size = Buffer.byteLength(text, "utf8")
  if (size <= max) {
    span.setAttribute(key, text)
    span.setAttribute(`${key}.size_bytes`, size)
    return
  }
  // Slice by bytes, not chars, to honour the cap precisely.
  const cut = Buffer.from(text, "utf8").subarray(0, max).toString("utf8")
  span.setAttribute(key, cut + `…[truncated ${size - max} bytes]`)
  span.setAttribute(`${key}.size_bytes`, size)
  span.setAttribute(`${key}.truncated`, true)
}
