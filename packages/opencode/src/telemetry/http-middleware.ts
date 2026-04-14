import type { MiddlewareHandler } from "hono"
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api"

const TRACER_NAME = "opencode.server"

export function tracingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const tracer = trace.getTracer(TRACER_NAME)
    const method = c.req.method
    // Start with a placeholder name; we'll update it after routing resolves the pattern.
    const span = tracer.startSpan(`${method} ${c.req.path}`, {
      kind: SpanKind.SERVER,
      attributes: {
        "http.method": method,
        "http.target": c.req.path,
      },
    })

    const ctx = trace.setSpan(context.active(), span)

    try {
      await context.with(ctx, () => next())

      // After next() the router has resolved the matched route pattern.
      const route =
        c.req.matchedRoutes[c.req.routeIndex]?.path || c.req.routePath || c.req.path
      span.updateName(`${method} ${route}`)
      span.setAttribute("http.route", route)

      const status = c.res.status
      span.setAttribute("http.status_code", status)

      // If Hono's onError handler caught an exception from a downstream handler,
      // it sets c.error. Record it even though next() resolved normally.
      if (c.error) {
        span.recordException(c.error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: c.error.message })
      } else if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
    } catch (err) {
      span.recordException(err as Error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
      span.setAttribute("http.status_code", 500)
      throw err
    } finally {
      span.end()
    }
  }
}
