import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { Log } from "@/util/log"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { AsyncQueue } from "../../util/queue"

const log = Log.create({ service: "server" })

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description:
        "Subscribe to the server-sent event stream. Pass `?sessionID=ses_...` to filter to events belonging to a single session. Filtering is permissive: events whose sessionID exists and doesn't match are dropped, but events with no sessionID at all (server lifecycle frames, cross-aggregate events) are always forwarded so the client can still detect connection state.",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(BusEvent.payloads()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        sessionID: z
          .string()
          .optional()
          .meta({ description: "Only forward events whose properties.sessionID matches this value" }),
      }),
    ),
    async (c) => {
      const { sessionID: filterSessionID } = c.req.valid("query")
      log.info("event connected", { sessionID: filterSessionID ?? "(all)" })
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
      return streamSSE(c, async (stream) => {
        const q = new AsyncQueue<string | null>()
        let done = false

        q.push(
          JSON.stringify({
            type: "server.connected",
            properties: {},
          }),
        )

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          q.push(
            JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }),
          )
        }, 10_000)

        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unsub()
          q.push(null)
          log.info("event disconnected")
        }

        const unsub = Bus.subscribeAll((event) => {
          // When a sessionID filter is set, drop only events whose sessionID
          // exists and doesn't match. Events with no sessionID at all are
          // passed through (permissive default) so clients don't silently
          // miss non-session-scoped events like server.* lifecycle frames or
          // any future cross-aggregate event. session.created is the one
          // edge case where the id lives under properties.info.id.
          if (filterSessionID) {
            const props = (event as any).properties as any
            const sid = props?.sessionID ?? props?.info?.id
            if (sid !== undefined && sid !== filterSessionID) {
              if (event.type === Bus.InstanceDisposed.type) stop()
              return
            }
          }
          q.push(JSON.stringify(event))
          if (event.type === Bus.InstanceDisposed.type) {
            stop()
          }
        })

        stream.onAbort(stop)

        try {
          for await (const data of q) {
            if (data === null) return
            await stream.writeSSE({ data })
          }
        } finally {
          stop()
        }
      })
    },
  )
