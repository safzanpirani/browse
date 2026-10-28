// A copy of the unpacked extension can pin its relay port with a packaged relay-port.json ({ "port": 19960 }),
// written by `opencode-browser profiles add`. Each relay takes one extension connection, so each browser profile loads
// its own copy and talks to its own relay. The agentRelayPort storage override still wins (agent-relay.ts).
import { isJsonObject } from "../agent-relay/protocol"

const RELAY_PORT_FILE = "relay-port.json"

/** The port in this build's relay-port.json, or undefined when the file is missing or invalid. */
export async function packagedRelayPort(): Promise<number | undefined> {
  try {
    const response = await fetch(chrome.runtime.getURL(RELAY_PORT_FILE))
    if (!response.ok) return undefined
    const config: unknown = await response.json()
    const port = isJsonObject(config) ? config.port : undefined
    return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
  } catch {
    return undefined
  }
}
