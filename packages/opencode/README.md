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

## Logging

Logs are written to stderr (or a rotated file under the opencode log directory). When handling a session, each log line is automatically tagged `sessionID=<id>`.

### Shipping to Volcengine TLS

Set all of the following environment variables and every log line will be shipped to a TLS log topic (in addition to the local sink):

- `VOLCENGINE_ACCESS_KEY_ID`
- `VOLCENGINE_ACCESS_KEY_SECRET`
- `VOLCENGINE_ENDPOINT` (e.g. `tls-cn-beijing.volces.com`)
- `VOLCENGINE_REGION` (e.g. `cn-beijing`)
- `OPENCODE_TLS_TOPIC_ID`

Optional:

- `OPENCODE_TLS_SOURCE` (defaults to `opencode`)
- `OPENCODE_TLS_DISABLED=1` — disables the sink even when the above are set (handy for local development with prod credentials in your shell)

Delivery is best-effort, batched (100 records / 2s), and bounded at 5000 in-memory records. On shutdown, opencode attempts one final flush with a 2-second timeout.
