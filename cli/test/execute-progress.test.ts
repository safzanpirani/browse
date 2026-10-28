import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ExecuteSandbox, type ExecuteProgress } from "../src/execute.ts"
import { finalizationPendingRedaction } from "../src/network-capture.ts"

// What a session reports when --timeout-ms stops a script: ExecuteSandbox.executeProgress(). The sandbox's network
// capture and page connection are replaced with stand-ins; no browser.

/** A network capture whose redaction doesn't know any secret yet, as while it is still finalizing requests. */
function capture(options: { readonly settled: boolean; readonly settle?: Promise<void> }) {
  const { promise: settling, resolve: startedSettling } = Promise.withResolvers<void>()
  return {
    /** Resolves once the execute starts settling its output. */
    settling,
    outputSettled: () => options.settled,
    settleForOutput: async () => {
      startedSettling()
      await options.settle
    },
    redactText: (text: string) => text,
    redactUrl: (url: string) => url,
    redactValue: (value: unknown) => value,
    status: () => ({ active: true }),
  }
}

describe("execute progress", () => {
  test("is withheld while the network capture is still finalizing, since it may not know those secrets yet", () => {
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://127.0.0.1:0" })
    const secretUrl = "https://example.com/callback?code=s3cr3t-oauth-code"
    const progress: ExecuteProgress = {
      logs: [{ source: "script", type: "log", text: `token: s3cr3t-oauth-code`, location: { url: secretUrl, lineNumber: 1, columnNumber: 1 } }],
      logSummary: { totalCount: 1, returnedCount: 1, repeatedCount: 0, omittedCount: 0 },
      aftermath: { startUrl: "https://example.com/", endUrl: secretUrl, navigations: [secretUrl], consoleErrorCount: 0, pageErrorCount: 0, handoffs: 0 },
    }
    Reflect.set(sandbox, "networkCapture", capture({ settled: false }))
    Reflect.set(sandbox, "readRunningProgress", () => progress)
    const reported = sandbox.executeProgress()
    expect(JSON.stringify(reported)).not.toContain("s3cr3t")
    expect(reported?.logs[0]?.text).toBe(finalizationPendingRedaction)
    expect(reported?.logSummary).toEqual(progress.logSummary)
    expect(reported?.aftermath.navigations).toEqual([finalizationPendingRedaction])
  })

  test("survives the end of user code until the execute's result is built", async () => {
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://127.0.0.1:0" })
    const { promise: settle, resolve: settled } = Promise.withResolvers<void>()
    const networkCapture = capture({ settled: true, settle })
    Reflect.set(sandbox, "networkCapture", networkCapture)
    const page = { on() {}, off() {}, mainFrame: () => ({}), isClosed: () => false, url: () => "https://example.com/" }
    Reflect.set(sandbox, "getGlobals", async () => ({ page, state: {}, modules: {}, handoffTracker: { count: 0 } }))
    const result = Effect.runPromise(sandbox.execute(`console.log("step 1 done"); return 1`))
    await networkCapture.settling
    // The script has returned; the execute still waits for the capture to settle its output, where a timeout can land.
    expect(sandbox.executeProgress()).toMatchObject({
      logs: [{ source: "script", type: "log", text: "step 1 done" }],
      logSummary: { totalCount: 1 },
      aftermath: { endUrl: "https://example.com/" },
    })
    settled()
    expect((await result).text).toBe("1")
    expect(sandbox.executeProgress()).toBeUndefined()
  })
})
