import "./util/xhr-polyfill"
import { TelemetryPreflight } from "./telemetry/preflight-config"

const preflight = TelemetryPreflight.load()
const traces = preflight.traces

const tracesEnabledFromConfig = traces?.enabled
const tracesEnabledFromEnv =
  process.env["OPENCODE_OTEL_ENABLED"] === "true" || process.env["OPENCODE_OTEL_ENABLED"] === "1"
const tracesEnabled = tracesEnabledFromConfig ?? tracesEnabledFromEnv

if (tracesEnabled) {
  const provider = traces?.provider ?? "otlp-http"
  let url: string | undefined
  let headers: Record<string, string> | undefined

  if (provider === "volcengine.tls") {
    // Traces must carry their own credentials — logs and traces are separate
    // TLS resources and may belong to different AK/SK pairs.
    const ak = traces?.accessKeyId
    const sk = traces?.accessKeySecret
    const region = traces?.region
    const topicId = traces?.topicId
    const host = traces?.endpoint?.replace(/^https?:\/\//, "")

    if (ak && sk && region && topicId && host) {
      url = `https://${host}:4318/v1/traces`
      headers = {
        "x-tls-otel-tracetopic": topicId,
        "x-tls-otel-ak": ak,
        "x-tls-otel-sk": sk,
        "x-tls-otel-region": region,
      }
    } else {
      console.error(
        "[telemetry] provider 'volcengine.tls' requires endpoint, region, topicId, accessKeyId, accessKeySecret — tracing disabled",
      )
    }
  } else {
    if (traces?.endpoint) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = traces.endpoint
  }

  if (traces?.serviceName) process.env.OTEL_SERVICE_NAME = traces.serviceName
  const ratioRaw =
    traces?.sampleRatio !== undefined
      ? traces.sampleRatio
      : Number(process.env["OPENCODE_OTEL_SAMPLE_RATIO"] ?? "1")
  const ratio = Number(ratioRaw)

  // Skip bootstrap if volcengine.tls was requested but misconfigured.
  const okToBootstrap = provider !== "volcengine.tls" || (url && headers)
  if (okToBootstrap) {
    // Pre-resolve modules that don't play well with OTel's require-in-the-middle
    // hook. The Volcengine TLS SDK pulls in axios@0.21.4 / follow-redirects which
    // creates CustomError subclasses at load time — if the require hook is active
    // when that happens, the error constructor path throws. Loading it *before*
    // bootstrap() caches the module so subsequent imports are no-ops.
    try {
      await import("@volcengine/openapi")
    } catch {}
    const { bootstrap } = await import("./telemetry/otel")
    await bootstrap({
      enabled: true,
      serviceName: process.env["OTEL_SERVICE_NAME"] ?? "opencode",
      sampleRatio: Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1,
      url,
      headers,
    })
  }
}

await import("./main")
