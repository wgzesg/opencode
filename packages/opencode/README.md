# js

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.12. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Observability

opencode emits structured logs and OpenTelemetry traces. When handling a session, every log line and every span is automatically tagged with the session ID (`sessionID=…` on log lines, `session.id` attribute on spans).

Both sinks are optional. Configure them via `opencode.json` (hybrid provider-based config, values take precedence over env) or environment variables.

### `opencode.json` telemetry block

```json
{
  "telemetry": {
    "logs": {
      "provider": "volcengine.tls",
      "accessKeyId": "AKLT...",
      "accessKeySecret": "...",
      "endpoint": "tls-cn-beijing.volces.com",
      "region": "cn-beijing",
      "topicId": "…",
      "source": "opencode"
    },
    "traces": {
      "provider": "otlp-http",
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "serviceName": "opencode",
      "sampleRatio": 1
    }
  }
}
```

Config lookup order (higher wins): project `opencode.json` → `$OPENCODE_CONFIG_DIR/opencode.json` → `~/.config/opencode/opencode.json` → `~/.opencode/opencode.json`. Inside each block, any missing field falls back to the corresponding environment variable.

### Trace exporter providers

Three modes, selected by `telemetry.traces.provider` (and `enabled`):

1. **Disabled** — omit the `traces` block, or set `"enabled": false`. No OTel SDK is bootstrapped.
2. **Local / generic OTLP HTTP** — `"provider": "otlp-http"`. Plain unauthenticated OTLP to `endpoint` (e.g. Jaeger all-in-one at `http://localhost:4318`).
3. **Volcengine TLS trace topic** — `"provider": "volcengine.tls"`. Ships OTLP spans directly to a TLS Trace instance using the documented `x-tls-otel-*` HTTP headers. First create a Trace instance in the TLS console (it auto-creates the backing log topic). Then:

   ```json
   "traces": {
     "provider": "volcengine.tls",
     "enabled": true,
     "endpoint": "tls-cn-beijing.volces.com",
     "region": "cn-beijing",
     "topicId": "<trace topic id from the console>",
     "accessKeyId": "AKLT...",
     "accessKeySecret": "...",
     "serviceName": "opencode",
     "sampleRatio": 1
   }
   ```

   Notes:
   - `endpoint` is the bare host (no scheme, no port). The exporter POSTs to `https://<endpoint>:4318/v1/traces`.
   - Traces carry their own `accessKeyId` / `accessKeySecret` / `region` / `topicId`; the logs block is never used as a fallback, since a TLS Trace instance may live under a different AK/SK or region than the log topic.
   - Query traces in the console with e.g. `* | select * where TraceID = '...'`.

### Environment variable fallback

Logs (Volcengine TLS):

- `VOLCENGINE_ACCESS_KEY_ID`
- `VOLCENGINE_ACCESS_KEY_SECRET`
- `VOLCENGINE_ENDPOINT` (e.g. `tls-cn-beijing.volces.com`)
- `VOLCENGINE_REGION` (e.g. `cn-beijing`)
- `OPENCODE_TLS_TOPIC_ID`
- `OPENCODE_TLS_SOURCE` — optional, defaults to `opencode`
- `OPENCODE_TLS_DISABLED=1` — kill switch

Traces (OpenTelemetry):

- `OPENCODE_OTEL_ENABLED=1` — turns on the OTel SDK (respected when config block doesn't set `enabled`)
- `OTEL_EXPORTER_OTLP_ENDPOINT` — OTLP HTTP collector (default `http://localhost:4318`)
- `OTEL_SERVICE_NAME` — service label (default `opencode`)
- `OPENCODE_OTEL_SAMPLE_RATIO` — `0.0`–`1.0`, default `1`

### What you see in traces

Custom spans carrying `session.id`:

- `session.create`, `session.fork`, `session.initialize`, `session.set_title`, `session.set_archived`, `session.share`, `session.remove`
- `session.prompt.body`, `session.prompt.cancel`, `session.compact`, `session.summary`, `session.command`
- `llm.stream` (attrs: `provider.id`, `model.id`, `agent.name`, `llm.input_tokens`, `llm.output_tokens`, `llm.finish_reason`)
- `tool.<name>` for every tool invocation (attrs: `tool.name`, `message.id`, `agent.name`, `tool.call_id`)
- `provider.get_language`, `provider.get_provider`
- `permission.ask`
- `db.use` (attrs: `db.backend`)

Root spans come from the server's HTTP middleware (`GET /session/:id/...`, etc.) and from CLI entrypoints.

### Delivery behavior

TLS log shipping is best-effort, batched (100 records / 2 s), bounded at 5 000 in-memory records. On shutdown opencode attempts one final flush with a 2-second timeout. Spans are batched by the OTel SDK's default BatchSpanProcessor.
