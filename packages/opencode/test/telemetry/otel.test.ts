import { describe, expect, test, afterEach } from "bun:test"
import { trace } from "@opentelemetry/api"
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { bootstrap, shutdown } from "../../src/telemetry/otel"

describe("otel bootstrap", () => {
  afterEach(async () => {
    await shutdown()
  })

  test("registers a global tracer provider when enabled", async () => {
    const exporter = new InMemorySpanExporter()
    await bootstrap({ enabled: true, serviceName: "opencode-test", sampleRatio: 1, exporter })

    const tracer = trace.getTracer("test")
    const span = tracer.startSpan("unit-span")
    span.setAttribute("k", "v")
    span.end()

    await exporter.forceFlush?.()
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe("unit-span")
    expect(spans[0].attributes.k).toBe("v")
    expect(spans[0].resource.attributes["service.name"]).toBe("opencode-test")
  })

  test("is a no-op when disabled", async () => {
    await bootstrap({ enabled: false, serviceName: "opencode-test", sampleRatio: 1 })
    const tracer = trace.getTracer("test")
    const span = tracer.startSpan("should-not-record")
    expect(span.isRecording()).toBe(false)
    span.end()
  })
})
