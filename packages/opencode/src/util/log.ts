import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import { AsyncLocalStorage } from "async_hooks"
import { Global } from "../global"
import z from "zod"
import { Glob } from "./glob"
import { LogTls } from "./log-tls"

export namespace Log {
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = "INFO"

  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  export type Logger = {
    debug(message?: any, extra?: Record<string, any>): void
    info(message?: any, extra?: Record<string, any>): void
    error(message?: any, extra?: Record<string, any>): void
    warn(message?: any, extra?: Record<string, any>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(
      message: string,
      extra?: Record<string, any>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()

  const sessionStore = new AsyncLocalStorage<{ sessionID: string }>()

  export function withSession<T>(sessionID: string, fn: () => T): T {
    return sessionStore.run({ sessionID }, fn)
  }

  export function currentSessionID(): string | undefined {
    return sessionStore.getStore()?.sessionID
  }

  export const Default = create({ service: "default" })

  export interface Options {
    print: boolean
    dev?: boolean
    level?: Level
  }

  let logpath = ""
  export function file() {
    return logpath
  }
  let write = (msg: any) => {
    process.stderr.write(msg)
    return msg.length
  }

  export async function init(options: Options) {
    if (options.level) level = options.level
    cleanup(Global.Path.log)
    if (options.print) {
      logpath = ""
      write = (msg: any) => {
        process.stderr.write(msg)
        return msg.length
      }
      return
    }
    logpath = path.join(
      Global.Path.log,
      options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
    )
    await fs.truncate(logpath).catch(() => {})
    const stream = createWriteStream(logpath, { flags: "a" })
    write = async (msg: any) => {
      return new Promise((resolve, reject) => {
        stream.write(msg, (err) => {
          if (err) reject(err)
          else resolve(msg.length)
        })
      })
    }
  }

  async function cleanup(dir: string) {
    const files = await Glob.scan("????-??-??T??????.log", {
      cwd: dir,
      absolute: true,
      include: "file",
    })
    if (files.length <= 5) return

    const filesToDelete = files.slice(0, -10)
    await Promise.all(filesToDelete.map((file) => fs.unlink(file).catch(() => {})))
  }

  function formatError(error: Error, depth = 0): string {
    const result = error.message
    return error.cause instanceof Error && depth < 10
      ? result + " Caused by: " + formatError(error.cause, depth + 1)
      : result
  }

  let last = Date.now()
  export function create(tags?: Record<string, any>) {
    tags = tags || {}

    const service = tags["service"]
    if (service && typeof service === "string") {
      const cached = loggers.get(service)
      if (cached) {
        return cached
      }
    }

    function build(message: any, extra?: Record<string, any>) {
      const implicit = sessionStore.getStore()
      const merged: Record<string, any> = {
        ...(implicit?.sessionID ? { sessionID: implicit.sessionID } : {}),
        ...tags,
        ...extra,
      }
      const prefix = Object.entries(merged)
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          const prefix = `${key}=`
          if (value instanceof Error) return prefix + formatError(value)
          if (typeof value === "object") return prefix + JSON.stringify(value)
          return prefix + value
        })
        .join(" ")
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()
      return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
    }
    const result: Logger = {
      debug(message?: any, extra?: Record<string, any>) {
        if (!shouldLog("DEBUG")) return
        const implicit = sessionStore.getStore()
        const merged: Record<string, any> = {
          ...(implicit?.sessionID ? { sessionID: implicit.sessionID } : {}),
          ...tags,
          ...extra,
        }
        write("DEBUG " + build(message, extra))
        LogTls.enqueue({
          time: Date.now(),
          level: "DEBUG",
          message: message === undefined || message === null ? "" : String(message),
          tags: merged,
        })
      },
      info(message?: any, extra?: Record<string, any>) {
        if (!shouldLog("INFO")) return
        const implicit = sessionStore.getStore()
        const merged: Record<string, any> = {
          ...(implicit?.sessionID ? { sessionID: implicit.sessionID } : {}),
          ...tags,
          ...extra,
        }
        write("INFO  " + build(message, extra))
        LogTls.enqueue({
          time: Date.now(),
          level: "INFO",
          message: message === undefined || message === null ? "" : String(message),
          tags: merged,
        })
      },
      error(message?: any, extra?: Record<string, any>) {
        if (!shouldLog("ERROR")) return
        const implicit = sessionStore.getStore()
        const merged: Record<string, any> = {
          ...(implicit?.sessionID ? { sessionID: implicit.sessionID } : {}),
          ...tags,
          ...extra,
        }
        write("ERROR " + build(message, extra))
        LogTls.enqueue({
          time: Date.now(),
          level: "ERROR",
          message: message === undefined || message === null ? "" : String(message),
          tags: merged,
        })
      },
      warn(message?: any, extra?: Record<string, any>) {
        if (!shouldLog("WARN")) return
        const implicit = sessionStore.getStore()
        const merged: Record<string, any> = {
          ...(implicit?.sessionID ? { sessionID: implicit.sessionID } : {}),
          ...tags,
          ...extra,
        }
        write("WARN  " + build(message, extra))
        LogTls.enqueue({
          time: Date.now(),
          level: "WARN",
          message: message === undefined || message === null ? "" : String(message),
          tags: merged,
        })
      },
      tag(key: string, value: string) {
        if (tags) tags[key] = value
        return result
      },
      clone() {
        return Log.create({ ...tags })
      },
      time(message: string, extra?: Record<string, any>) {
        const now = Date.now()
        result.info(message, { status: "started", ...extra })
        function stop() {
          result.info(message, {
            status: "completed",
            duration: Date.now() - now,
            ...extra,
          })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }

    if (service && typeof service === "string") {
      loggers.set(service, result)
    }

    return result
  }
}
