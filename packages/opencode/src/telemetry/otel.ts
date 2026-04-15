import { trace, diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { Resource } from "@opentelemetry/resources"
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions"
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base"

export interface BootstrapOptions {
  enabled: boolean
  serviceName: string
  sampleRatio: number
  /** Full OTLP HTTP traces URL (e.g. 'https://tls-cn-beijing.volces.com:4318/v1/traces'). */
  url?: string
  /** Extra headers for the OTLP HTTP exporter (e.g. Volcengine TLS auth headers). */
  headers?: Record<string, string>
  /** Optional exporter override — used in tests. */
  exporter?: SpanExporter
}

let sdk: NodeSDK | undefined

export async function bootstrap(opts: BootstrapOptions): Promise<void> {
  if (!opts.enabled) return
  if (sdk) return

  // Surface OTel internal warnings/errors (export failures, auth rejects)
  // to stderr. Opt into verbose/debug via OPENCODE_OTEL_LOG=debug|verbose.
  const lvl = (process.env["OPENCODE_OTEL_LOG"] ?? "").toLowerCase()
  const diagLevel =
    lvl === "verbose" ? DiagLogLevel.VERBOSE
    : lvl === "debug" ? DiagLogLevel.DEBUG
    : lvl === "info" ? DiagLogLevel.INFO
    : DiagLogLevel.WARN
  diag.setLogger(new DiagConsoleLogger(), diagLevel)

  const endpointSummary = opts.url ?? process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "(default)"
  process.stderr.write(
    `INFO  [otel] bootstrap service=${opts.serviceName} endpoint=${endpointSummary} sampleRatio=${opts.sampleRatio} authHeaders=${opts.headers ? Object.keys(opts.headers).join(",") : "none"}\n`,
  )

  const exporter =
    opts.exporter ??
    new OTLPTraceExporter({
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
    })

  // Use SimpleSpanProcessor for test exporters (no batching delay);
  // BatchSpanProcessor for production to minimise export overhead.
  const spanProcessor = opts.exporter
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter)

  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: opts.serviceName,
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(opts.sampleRatio),
    }),
    // Cast to any[] to tolerate sdk-trace-base version skew between sdk-node
    // (pins 1.28.x) and the version installed in packages/opencode (1.30.x).
    // The runtime types are compatible; only the private `_spanContext` brand differs.
    spanProcessors: [spanProcessor] as any[],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem tracing is noisy and unhelpful for session observability.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        // Disable http/https auto-instrumentation: it uses require-in-the-middle,
        // which breaks follow-redirects (used by the Volcengine TLS SDK's axios).
        // Our Hono middleware already tracks server-side HTTP; outbound HTTP can
        // be added manually if needed.
        "@opentelemetry/instrumentation-http": { enabled: false },
      }),
    ],
  })

  sdk.start()

  // Wait for the provider's async resource attributes to resolve so that
  // any spans created immediately after bootstrap() are exported synchronously.
  const tp = trace.getTracerProvider() as any
  const delegate = tp.getDelegate?.()
  if (delegate?.resource?.waitForAsyncAttributes) {
    await delegate.resource.waitForAsyncAttributes()
  }
}

export async function shutdown(): Promise<void> {
  if (!sdk) return
  await sdk.shutdown()
  sdk = undefined
  // Reset the global tracer provider so subsequent tests that call
  // bootstrap({ enabled: false }) get a true no-op tracer.
  trace.disable()
}
