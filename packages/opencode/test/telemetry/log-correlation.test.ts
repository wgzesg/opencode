import { describe, expect, test, afterEach } from "bun:test"
import { context, trace } from "@opentelemetry/api"
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { bootstrap, shutdown } from "../../src/telemetry/otel"
import { activeSpanIds } from "../../src/telemetry/log-correlation"

describe("activeSpanIds", () => {
  afterEach(async () => {
    await shutdown()
  })

  test("returns empty object when no active span", () => {
    expect(activeSpanIds()).toEqual({})
  })

  test("returns trace_id and span_id when inside an active span", async () => {
    await bootstrap({
      enabled: true,
      serviceName: "opencode-test",
      sampleRatio: 1,
      exporter: new InMemorySpanExporter(),
    })
    const tracer = trace.getTracer("test")
    const span = tracer.startSpan("outer")
    context.with(trace.setSpan(context.active(), span), () => {
      const ids = activeSpanIds()
      expect(ids.trace_id).toMatch(/^[0-9a-f]{32}$/)
      expect(ids.span_id).toMatch(/^[0-9a-f]{16}$/)
    })
    span.end()
  })
})
