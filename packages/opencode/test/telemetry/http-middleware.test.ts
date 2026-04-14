import { describe, expect, test, afterEach } from "bun:test"
import { Hono } from "hono"
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { SpanStatusCode } from "@opentelemetry/api"
import { bootstrap, shutdown } from "../../src/telemetry/otel"
import { tracingMiddleware } from "../../src/telemetry/http-middleware"

// Create a fresh exporter per test to avoid the _stopped flag set by sdk.shutdown().
let exporter = new InMemorySpanExporter()

describe("tracingMiddleware", () => {
  afterEach(async () => {
    await shutdown()
    exporter = new InMemorySpanExporter()
  })

  async function setup() {
    await bootstrap({ enabled: true, serviceName: "opencode-test", sampleRatio: 1, exporter })
  }

  test("emits a span named by method and route pattern", async () => {
    await setup()
    const app = new Hono().use(tracingMiddleware()).get("/session/:id/message", (c) => c.text("ok"))
    const res = await app.request("/session/abc/message")
    expect(res.status).toBe(200)

    await exporter.forceFlush?.()
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe("GET /session/:id/message")
    expect(spans[0].attributes["http.method"]).toBe("GET")
    expect(spans[0].attributes["http.route"]).toBe("/session/:id/message")
    expect(spans[0].attributes["http.status_code"]).toBe(200)
    expect(spans[0].status.code).toBe(SpanStatusCode.UNSET)
  })

  test("sets ERROR status when handler returns 5xx", async () => {
    await setup()
    const app = new Hono().use(tracingMiddleware()).get("/boom", (c) => c.text("fail", 500))
    await app.request("/boom")

    await exporter.forceFlush?.()
    const spans = exporter.getFinishedSpans()
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR)
    expect(spans[0].attributes["http.status_code"]).toBe(500)
  })

  test("records exception when handler throws", async () => {
    await setup()
    const app = new Hono()
      .use(tracingMiddleware())
      .get("/throws", () => {
        throw new Error("nope")
      })
      .onError((_err, c) => c.text("handled", 500))
    await app.request("/throws")

    await exporter.forceFlush?.()
    const spans = exporter.getFinishedSpans()
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR)
    expect(spans[0].events.some((e) => e.name === "exception")).toBe(true)
  })
})
