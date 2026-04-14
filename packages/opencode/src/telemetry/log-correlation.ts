import { trace } from "@opentelemetry/api"

export function activeSpanIds(): { trace_id?: string; span_id?: string } {
  const span = trace.getActiveSpan()
  if (!span) return {}
  const ctx = span.spanContext()
  if (!ctx.traceId || !ctx.spanId) return {}
  return { trace_id: ctx.traceId, span_id: ctx.spanId }
}
