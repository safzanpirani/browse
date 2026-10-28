import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// The relay port the extension dials: the agentRelayPort storage override, else a packaged relay-port.json (a profile
// copy written by `opencode-browser profiles add`), else the default 19988. Run by ../isolated.test.ts in a process of
// its own (its relay keeps chrome listeners and a WebSocket). WebSocket is a fake that never opens.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
const CODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly made: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this)
  }
  send() {}
  close(code = 1006, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: false }))
  }
}

/** The packaged relay-port.json body, or undefined for no file. */
let packaged: unknown
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input)
  if (url.endsWith("/relay-pairing.json")) return Response.json({ code: CODE })
  if (url.endsWith("/relay-port.json") && packaged !== undefined) return Response.json(packaged)
  return new Response("not found", { status: 404 })
}) as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

// Imported after the fakes: the modules read chrome, fetch and WebSocket from globals.
const { packagedRelayPort } = await import("../../src/background/relay-port")
const { createAgentRelay } = await import("../../src/background/agent-relay")

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("packagedRelayPort reads a valid port and ignores a missing or invalid file", async () => {
  packaged = undefined
  expect(await packagedRelayPort()).toBeUndefined()
  for (const invalid of [{ port: "19960" }, { port: 0 }, { port: 70000 }, { port: 19960.5 }, [19960], { other: 1 }]) {
    packaged = invalid
    expect(await packagedRelayPort()).toBeUndefined()
  }
  packaged = { port: 19961 }
  expect(await packagedRelayPort()).toBe(19961)
})

let relay: { reconnect(): void }
const lastUrl = () => FakeWebSocket.made.at(-1)?.url

test("a packaged relay-port.json sets the port when storage has none", async () => {
  packaged = { port: 19961 }
  relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
  await until(() => FakeWebSocket.made.length > 0)
  expect(FakeWebSocket.made.map((socket) => socket.url)).toEqual(["ws://127.0.0.1:19961/extension"])
})

test("the storage override still wins over the packaged file", async () => {
  const before = FakeWebSocket.made.length
  FakeWebSocket.made.at(-1)!.close()
  await settle()
  await stub.chrome.storage.local.set({ agentRelayPort: 19925 })
  relay.reconnect()
  await until(() => FakeWebSocket.made.length > before)
  expect(lastUrl()).toBe("ws://127.0.0.1:19925/extension")
})

test("without either, the extension dials the default port", async () => {
  const before = FakeWebSocket.made.length
  FakeWebSocket.made.at(-1)!.close()
  await settle()
  packaged = undefined
  await stub.chrome.storage.local.remove("agentRelayPort")
  relay.reconnect()
  await until(() => FakeWebSocket.made.length > before)
  expect(lastUrl()).toBe("ws://127.0.0.1:19988/extension")
})
