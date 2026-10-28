import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { relayBuildCheck } from "../src/doctor.ts"
import type * as RelayClient from "../src/relay-client.ts"
import { ensureRelay, relayBuildDrift, relayBuildProblem } from "../src/relay-lifecycle.ts"
import type { RelayVersion } from "../src/relay-schema.ts"

const relayBuild = "2026-10-21T17:00:00.000Z"
const cliBuild = "2026-10-23T02:00:00.000Z"

function relay(version: RelayVersion): RelayClient.Interface {
  return { endpoint: "http://127.0.0.1:1", version: Effect.succeed(version) } as unknown as RelayClient.Interface
}

describe("relay client protocol", () => {
  test("a relay from another build on the same client protocol is used as is, with a drift note", async () => {
    const running: RelayVersion = { version: "0.0.2", buildId: relayBuild, clientProtocol: 1, instanceId: "running", managed: true, shutdownProtocol: 2 }
    const result = await Effect.runPromise(ensureRelay({ relay: relay(running), buildId: cliBuild, clientProtocol: 1, start: Effect.die("should not start") }))
    expect(result).toEqual({ version: running, started: false })
    expect(relayBuildDrift(running, cliBuild, 1)).toContain("compatible protocol 1")
    expect(relayBuildDrift(running, relayBuild, 1)).toBeUndefined()
  })

  test("a different client protocol still demands a restart, or a client refresh when the relay is newer", () => {
    const running: RelayVersion = { version: "0.0.2", buildId: relayBuild, clientProtocol: 1 }
    expect(relayBuildProblem(running, cliBuild, 2)).toContain("incompatible with CLI protocol 2")
    expect(relayBuildProblem(running, cliBuild, 2)).toContain("relay restart")
    expect(relayBuildProblem({ ...running, clientProtocol: 3 }, cliBuild, 2)).toContain("refresh or restart this CLI or MCP client")
    expect(relayBuildDrift(running, cliBuild, 2)).toBeUndefined()
  })

  test("a legacy relay that reports no client protocol still needs the exact build", () => {
    expect(relayBuildProblem({ version: "0.0.2", buildId: relayBuild }, cliBuild, 1)).toContain("does not match CLI build")
    expect(relayBuildProblem({ version: "0.0.2", buildId: cliBuild }, cliBuild, 1)).toBeUndefined()
  })

  test("doctor's relay build check passes a compatible relay and warns on an incompatible one", () => {
    const value: RelayVersion = { version: "0.0.2", buildId: relayBuild, clientProtocol: 1 }
    expect(relayBuildCheck({ cliBuildId: cliBuild, clientProtocol: 1, relayResult: { ok: true, value } }))
      .toMatchObject({ status: "ok", message: `runtime ${relayBuild} differs from CLI ${cliBuild}; client protocol 1 is compatible` })
    expect(relayBuildCheck({ cliBuildId: cliBuild, clientProtocol: 2, relayResult: { ok: true, value } }))
      .toMatchObject({ status: "warn", message: `runtime ${relayBuild} is incompatible with CLI ${cliBuild}` })
    expect(relayBuildCheck({ cliBuildId: relayBuild, relayResult: { ok: true, value } }))
      .toMatchObject({ status: "ok", message: `matches CLI build (${relayBuild})` })
  })
})
