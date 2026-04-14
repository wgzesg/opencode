import { describe, expect, test, afterEach } from "bun:test"
import { context, trace } from "@opentelemetry/api"
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { bootstrap, shutdown } from "../../src/telemetry/otel"
import { activeSpanIds } from "../../src/telemetry/log-correlation"
import { Log } from "../../src/util/log"

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

describe("Log ↔ trace correlation", () => {
  afterEach(async () => {
    await shutdown()
  })

  test("log line includes trace_id when written inside an active span", async () => {
    await bootstrap({
      enabled: true,
      serviceName: "opencode-test",
      sampleRatio: 1,
      exporter: new InMemorySpanExporter(),
    })

    const captured: string[] = []
    const original = (Log as any).__setWriteForTest ?? null
    if (!original) throw new Error("Log test hook missing — add __setWriteForTest in src/util/log.ts")
    ;(Log as any).__setWriteForTest((msg: string) => {
      captured.push(msg)
    })

    const log = Log.create({ service: "corr-test" })
    const tracer = trace.getTracer("test")
    const span = tracer.startSpan("outer")
    context.with(trace.setSpan(context.active(), span), () => {
      log.info("hello")
    })
    span.end()

    ;(Log as any).__setWriteForTest(null)

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatch(/trace_id=[0-9a-f]{32}/)
    expect(captured[0]).toMatch(/span_id=[0-9a-f]{16}/)
  })
})
