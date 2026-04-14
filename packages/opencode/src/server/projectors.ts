import z from "zod"
import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session"
import { SessionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"
import { Log } from "../util/log"

async function handleConvertEvent(type: string, data: unknown): Promise<Record<string, unknown>> {
  if (type === "session.updated") {
    const id = (data as z.infer<typeof Session.Event.Updated.schema>).sessionID
    const row = await Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())

    if (!row) return data as Record<string, unknown>

    return {
      sessionID: id,
      info: Session.fromRow(row),
    }
  }
  return data as Record<string, unknown>
}

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: async (type, data) => {
      const sessionID =
        (data as any)?.sessionID ??
        (data as any)?.properties?.sessionID
      if (sessionID) {
        return Log.withSession(sessionID, () => handleConvertEvent(type, data))
      }
      return handleConvertEvent(type, data)
    },
  })
}

initProjectors()
