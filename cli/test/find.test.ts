import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findTabs, formatFindReport, matchQuery, sessionNameFor, visitedHosts, type FoundProfile } from "../src/find.ts"
import { relayToken } from "../src/relay-secrets.ts"

const temps: string[] = []
afterAll(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A data root with a profiles.json listing `profiles` (no extension copies: find doesn't read them). */
function dataRoot(profiles: { name: string; port: number; label?: string }[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-find-"))
  temps.push(root)
  fs.writeFileSync(path.join(root, "profiles.json"), JSON.stringify({ version: 1, profiles: profiles.map((profile) => ({ ...profile, createdAt: "" })) }))
  return root
}

function journal(root: string, session: string, entries: object[]) {
  fs.mkdirSync(path.join(root, "sessions", session), { recursive: true })
  fs.writeFileSync(path.join(root, "sessions", session, "journal.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\nnot json\n`)
}

const profile = (name: string, overrides: Partial<FoundProfile> = {}): FoundProfile => ({
  name,
  port: 19960,
  relay: "running",
  connected: true,
  tabs: [],
  sessions: [],
  visited: [],
  ...overrides,
})

describe("visitedHosts", () => {
  test("counts each profile's hosts by the entry's port, else by the session catalogs", () => {
    const root = dataRoot([{ name: "work", port: 19960 }, { name: "patty", port: 19963 }])
    journal(root, "a", [
      { port: 19960, startUrl: "about:blank", endUrl: "https://www.figma.com/file/1", navigations: ["https://figma.com/x"] },
      { port: 19960, startUrl: "https://mail.google.com/u/0", endUrl: "https://mail.google.com/u/0" },
      { port: 19960, endUrl: "https://myaccount.google.com/" },
      { port: 19960, endUrl: "https://${BC_SECRET_1}/" },
      { port: 19960, endUrl: "http://127.0.0.1:3000/" },
      { port: 19999, endUrl: "https://elsewhere.example/" },
    ])
    journal(root, "legacy", [{ endUrl: "https://figma.com/" }])
    fs.mkdirSync(path.join(root, "relays", "19963"), { recursive: true })
    fs.writeFileSync(path.join(root, "relays", "19963", "sessions.json"), JSON.stringify({ version: 1, sessions: [{ id: "legacy" }] }))
    const visited = visitedHosts([{ name: "work", port: 19960, extension: "", createdAt: "" }, { name: "patty", port: 19963, extension: "", createdAt: "" }], root)
    expect(visited.get("work")).toEqual(["figma.com", "mail.google.com", "myaccount.google.com"])
    expect(visited.get("patty")).toEqual(["figma.com"])
  })
})

describe("matchQuery", () => {
  const profiles = [
    profile("work", { visited: ["myaccount.google.com"], tabs: [{ tabId: 7, url: "https://www.figma.com/file/abc", title: "Board", owner: "user" }] }),
    profile("patty", { port: 19963, tabs: [{ tabId: 9, url: "https://github.com/", title: "Figma plugin issue", owner: "user", session: "gh" }] }),
    profile("ananya", { port: 19964, connected: false, visited: ["figma.com"] }),
  ]

  test("matches tabs by URL or title, and prints the command to adopt or continue each", () => {
    const result = matchQuery(profiles, "Figma")
    expect(result.matches.map(({ profile, tab, next }) => ({ profile, tab: tab.tabId, next: next.replace(/^.*? --profile/, "--profile") }))).toEqual([
      { profile: "work", tab: 7, next: "--profile work session adopt --tab-id 7 --session figma" },
      { profile: "patty", tab: 9, next: "--profile patty execute --session gh 'return page.url()'" },
    ])
    expect(result.visitedBy).toEqual(["ananya"])
    expect(result.advice).toBeUndefined()
  })

  test("without a matching tab, names the profiles whose sessions visited the host", () => {
    const result = matchQuery(profiles, "https://myaccount.google.com/security")
    expect(result.matches).toEqual([])
    expect(result.visitedBy).toEqual(["work"])
    expect(result.advice).toContain("Sessions on work visited it before")
    expect(matchQuery(profiles, "myaccount").visitedBy).toEqual(["work"])
    expect(matchQuery(profiles, "netflix.com").visitedBy).toEqual([])
    expect(matchQuery(profiles, "netflix.com").advice).toContain("No session visited it before")
  })

  test("names a session after the query's host", () => {
    expect(sessionNameFor("https://www.figma.com/file/x")).toBe("figma")
    expect(sessionNameFor("My Account")).toBe("my")
    expect(sessionNameFor("..")).toBe("tab")
  })
})

describe("findTabs", () => {
  test("asks each relay with the token, never starting one, and reports tabs and relay state", async () => {
    const stopped = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
    const stoppedPort = stopped.port!
    stopped.stop(true)
    let root = ""
    const relay = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) =>
        request.headers.get("authorization") === `Bearer ${relayToken(root)}` && new URL(request.url).pathname === "/extension/status"
          ? Response.json({
              connected: true,
              activeTargets: 1,
              sessions: [{ id: "figma" }],
              targets: [
                { id: "t1", type: "page", title: "Board", url: "https://www.figma.com/file/abc", tabId: 12, owner: "user", opencodeBrowserSessionId: "figma" },
                { id: "t2", type: "iframe", title: "", url: "https://figma.com/embed" },
              ],
            })
          : new Response("no", { status: 401 }),
    })
    const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unreachable through tunnel", { status: 502 }) })
    try {
      root = dataRoot([
        { name: "work", port: relay.port!, label: "Work (Profile 5)" },
        { name: "gone", port: stoppedPort },
        { name: "far", port: proxy.port! },
      ])
      const report = await findTabs("figma", root)
      expect(report.profiles.map(({ name, relay, connected, tabs, sessions }) => ({ name, relay, connected, tabs, sessions }))).toEqual([
        { name: "work", relay: "running", connected: true, tabs: [{ tabId: 12, url: "https://www.figma.com/file/abc", title: "Board", owner: "user", session: "figma" }], sessions: ["figma"] },
        { name: "gone", relay: "stopped", connected: false, tabs: [], sessions: [] },
        { name: "far", relay: "stopped", connected: false, tabs: [], sessions: [] },
      ])
      expect(report.matches.map((match) => match.next)).toEqual([expect.stringContaining("--profile work execute --session figma")])
      const text = formatFindReport(report)
      expect(text).toContain("work  port")
      expect(text).toContain("extension connected, 1 attached tab  [Work (Profile 5)]")
      expect(text).toContain("gone  port")
      expect(text).toContain("relay not running")
      expect(text).toContain('"figma" is attached on work (tab 12)')
    } finally {
      relay.stop(true)
      proxy.stop(true)
    }
  })
})
