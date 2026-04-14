import { SpanStatusCode, context, trace, type Attributes, type Span } from "@opentelemetry/api"

/**
 * Start a span, run `fn` inside its active context, then end the span.
 * Records exceptions and sets ERROR status on throw. Returns the result of `fn`.
 *
 * Call-sites should pass `session.id` (and any other relevant IDs) in `attrs`
 * so backend searches can filter the whole trace by session.
 */
export async function withSpan<T>(
  tracerName: string,
  spanName: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(tracerName)
  const span = tracer.startSpan(spanName, { attributes: attrs })
  const ctx = trace.setSpan(context.active(), span)
  try {
    return await context.with(ctx, () => fn(span))
  } catch (err) {
    span.recordException(err as Error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message ?? String(err) })
    throw err
  } finally {
    span.end()
  }
}

/**
 * Sync variant of {@link withSpan}. Use for tightly-bounded synchronous blocks.
 */
export function withSpanSync<T>(
  tracerName: string,
  spanName: string,
  attrs: Attributes,
  fn: (span: Span) => T,
): T {
  const tracer = trace.getTracer(tracerName)
  const span = tracer.startSpan(spanName, { attributes: attrs })
  const ctx = trace.setSpan(context.active(), span)
  try {
    return context.with(ctx, () => fn(span))
  } catch (err) {
    span.recordException(err as Error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message ?? String(err) })
    throw err
  } finally {
    span.end()
  }
}
