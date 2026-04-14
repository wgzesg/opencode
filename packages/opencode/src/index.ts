import { TelemetryPreflight } from "./telemetry/preflight-config"

const preflight = TelemetryPreflight.load()
const traces = preflight.traces

const tracesEnabledFromConfig = traces?.enabled
const tracesEnabledFromEnv =
  process.env["OPENCODE_OTEL_ENABLED"] === "true" || process.env["OPENCODE_OTEL_ENABLED"] === "1"
const tracesEnabled = tracesEnabledFromConfig ?? tracesEnabledFromEnv

if (tracesEnabled) {
  if (traces?.endpoint) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = traces.endpoint
  if (traces?.serviceName) process.env.OTEL_SERVICE_NAME = traces.serviceName
  const ratioRaw =
    traces?.sampleRatio !== undefined
      ? traces.sampleRatio
      : Number(process.env["OPENCODE_OTEL_SAMPLE_RATIO"] ?? "1")
  const ratio = Number(ratioRaw)
  const { bootstrap } = await import("./telemetry/otel")
  await bootstrap({
    enabled: true,
    serviceName: process.env["OTEL_SERVICE_NAME"] ?? "opencode",
    sampleRatio: Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1,
  })
}

await import("./main")
