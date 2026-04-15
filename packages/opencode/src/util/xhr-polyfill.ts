/**
 * Minimal XMLHttpRequest polyfill for Bun's compiled single-file binary.
 *
 * We build with `conditions: ["browser"]`, which makes dependencies like
 * `protobufjs` bundle their XHR-based resource loader. Bun's dev runtime
 * exposes `XMLHttpRequest` globally, but `bun build --compile` does not — so
 * `@volcengine/openapi`'s first `objToProtoBuffer` call throws
 * `ReferenceError: XMLHttpRequest is not defined`.
 *
 * This shim implements just enough of the XHR interface to satisfy
 * protobufjs's `fetch` path: async GET, file:// via fs, http(s) via fetch.
 */

const g = globalThis as any

if (typeof g.XMLHttpRequest === "undefined") {
  class XHRShim {
    method = "GET"
    url = ""
    private _headers: Record<string, string> = {}
    status = 0
    responseText = ""
    response: any = ""
    responseType = ""
    readyState = 0
    onreadystatechange: ((this: XHRShim) => void) | null = null
    onload: ((this: XHRShim) => void) | null = null
    onerror: ((this: XHRShim, e?: unknown) => void) | null = null
    withCredentials = false

    open(method: string, url: string) {
      this.method = method
      this.url = url
      this.readyState = 1
    }

    setRequestHeader(k: string, v: string) {
      this._headers[k] = v
    }

    getResponseHeader() {
      return null
    }

    abort() {}

    send(body?: unknown) {
      const finish = () => {
        this.readyState = 4
        try {
          this.onreadystatechange?.call(this)
        } catch {}
        try {
          this.onload?.call(this)
        } catch {}
      }
      const fail = (e?: unknown) => {
        this.status = 0
        this.readyState = 4
        try {
          this.onreadystatechange?.call(this)
        } catch {}
        try {
          this.onerror?.call(this, e)
        } catch {}
      }

      const isFile = this.url.startsWith("file://") || this.url.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(this.url)
      if (isFile) {
        try {
          const fs = require("fs") as typeof import("fs")
          const p = this.url.replace(/^file:\/\//, "")
          const text = fs.readFileSync(p, "utf8")
          this.responseText = text
          this.response = text
          this.status = 200
          finish()
        } catch (e) {
          fail(e)
        }
        return
      }

      fetch(this.url, {
        method: this.method,
        headers: this._headers,
        body: body as any,
      })
        .then(async (r) => {
          this.status = r.status
          const text = await r.text()
          this.responseText = text
          this.response = text
          finish()
        })
        .catch(fail)
    }
  }

  g.XMLHttpRequest = XHRShim
}
