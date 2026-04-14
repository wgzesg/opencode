if (process.env["OPENCODE_OTEL_ENABLED"] === "true" || process.env["OPENCODE_OTEL_ENABLED"] === "1") {
  const { bootstrap } = await import("./telemetry/otel")
  const ratio = Number(process.env["OPENCODE_OTEL_SAMPLE_RATIO"] ?? "1")
  await bootstrap({
    enabled: true,
    serviceName: process.env["OTEL_SERVICE_NAME"] ?? "opencode",
    sampleRatio: Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1,
  })
}

await import("./main")
