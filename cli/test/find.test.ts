import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findTabs, formatFindReport, matchQuery, sessionHistory, sessionNameFor, type FoundProfile } from "../src/find.ts"
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

describe("sessionHistory", () => {
  test("counts each profile's hosts by the entry's port, else by the session catalogs, and lists every session id", () => {
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
    fs.writeFileSync(path.join(root, "relays", "19963", "sessions.json"), JSON.stringify({ version: 1, sessions: [{ id: "legacy" }, { id: "no-journal" }] }))
    const history = sessionHistory([{ name: "work", port: 19960, extension: "", createdAt: "" }, { name: "patty", port: 19963, extension: "", createdAt: "" }], root)
    expect(history.visited.get("work")).toEqual(["figma.com", "mail.google.com", "myaccount.google.com"])
    expect(history.visited.get("patty")).toEqual(["figma.com"])
    expect([...history.sessionIds].sort()).toEqual(["a", "legacy", "no-journal"])
  })
})

describe("matchQuery", () => {
  const profiles = [
    profile("work", { visited: ["myaccount.google.com"], tabs: [{ tabId: 7, url: "https://www.figma.com/file/abc", title: "Board", owner: "user" }] }),
    profile("patty", { port: 19963, tabs: [{ tabId: 9, url: "https://github.com/", title: "Figma plugin issue", owner: "user", session: "gh", sessionDefault: true }] }),
    profile("ananya", { port: 19964, connected: false, visited: ["figma.com"] }),
  ]

  test("matches tabs by URL or title, and prints the command to adopt or continue each", () => {
    const result = matchQuery(profiles, "Figma", new Set())
    expect(result.matches.map(({ profile, tab, next, note }) => ({ profile, tab: tab.tabId, next: next.replace(/^.*? --profile/, "--profile"), note }))).toEqual([
      { profile: "work", tab: 7, next: "--profile work session adopt --tab-id 7 --session figma", note: undefined },
      { profile: "patty", tab: 9, next: "--profile patty execute --session gh 'return page.url()'", note: undefined },
    ])
    expect(result.visitedBy).toEqual(["ananya"])
    expect(result.advice).toBeUndefined()
  })

  test("adopts into a session id no profile uses yet, one per matching tab", () => {
    const two = [
      profile("work", { sessions: ["figma"], tabs: [{ tabId: 1, url: "https://figma.com/a", title: "", owner: "user" }] }),
      profile("patty", { port: 19963, tabs: [{ tabId: 2, url: "https://figma.com/b", title: "", owner: "user" }] }),
    ]
    // figma is live on work, figma-2 has a journal (sessionHistory's ids), so the two tabs get figma-3 and figma-4.
    const result = matchQuery(two, "figma.com", new Set(["figma-2"]))
    expect(result.matches.map((match) => match.next.replace(/^.*? --profile/, "--profile"))).toEqual([
      "--profile work session adopt --tab-id 1 --session figma-3",
      "--profile patty session adopt --tab-id 2 --session figma-4",
    ])
  })

  test("names the exact tab unless the relay reports it as the session's default page", () => {
    const app = (tabs: FoundProfile["tabs"]) => matchQuery([profile("work", { tabs })], "Sign in", new Set()).matches[0]
    const home = { tabId: 1, url: "https://app.example/home", title: "", owner: "relay" as const, session: "app" }
    const login = { tabId: 2, url: "https://app.example/login", title: "Sign in", owner: "relay" as const, session: "app" }
    // The default page: --session alone drives it.
    expect(app([{ ...login, sessionDefault: true }])?.next).toEndWith("--profile work execute --session app 'return page.url()'")
    // A popup beside the default page.
    expect(app([{ ...home, sessionDefault: true }, login])?.next).toEndWith("--profile work execute --session app --target-url https://app.example/login 'return page.url()'")
    // Only the popup is left and the default closed: --session alone would open a new page, so it still gets a selector.
    const orphan = app([login])
    expect(orphan?.next).toEndWith("--profile work execute --session app --target-url https://app.example/login 'return page.url()'")
    expect(orphan?.note).toBeUndefined()
    // Not the default, and another tab contains its URL: nothing names it alone, so the note says so.
    const twin = app([{ ...home, url: "https://app.example/login?next=1" }, login])
    expect(twin?.next).toEndWith("--profile work execute --session app 'return context.pages().map((p) => p.url())'")
    expect(twin?.note).toContain("tab 2 isn't session app's default page")
  })

  test("without a matching tab, names the profiles whose sessions visited the host", () => {
    const result = matchQuery(profiles, "https://myaccount.google.com/security", new Set())
    expect(result.matches).toEqual([])
    expect(result.visitedBy).toEqual(["work"])
    expect(result.advice).toContain("Sessions on work visited it before")
    expect(matchQuery(profiles, "myaccount", new Set()).visitedBy).toEqual(["work"])
    expect(matchQuery(profiles, "netflix.com", new Set()).visitedBy).toEqual([])
    expect(matchQuery(profiles, "netflix.com", new Set()).advice).toContain("No session visited it before")
  })

  test("names a session after the query's host, numbered past taken ids", () => {
    expect(sessionNameFor("https://www.figma.com/file/x", new Set())).toBe("figma")
    expect(sessionNameFor("My Account", new Set())).toBe("my")
    expect(sessionNameFor("..", new Set())).toBe("tab")
    expect(sessionNameFor("figma.com", new Set(["figma", "figma-2"]))).toBe("figma-3")
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
              activeTargets: 2,
              sessions: [{ id: "figma", targetId: "t1" }],
              targets: [
                { id: "t1", type: "page", title: "Board", url: "https://www.figma.com/file/abc", tabId: 12, owner: "user", opencodeBrowserSessionId: "figma" },
                { id: "t2", type: "iframe", title: "", url: "https://figma.com/embed" },
                { id: "t3", type: "page", title: "Figma login", url: "https://www.figma.com/login", tabId: 13, owner: "relay", opencodeBrowserSessionId: "figma" },
              ],
            })
          : new Response("no", { status: 401 }),
    })
    const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unreachable through tunnel", { status: 502 }) })
    const realFetch = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
      asked.push(String(input))
      return realFetch(input, init)
    }, realFetch)
    try {
      root = dataRoot([
        { name: "work", port: relay.port!, label: "Work (Profile 5)" },
        { name: "gone", port: stoppedPort },
        { name: "far", port: proxy.port! },
        // Hand-edited onto browser-control's relay, and onto its browse-remote offset: never sent the token.
        { name: "bc", port: 19990 },
        { name: "bcremote", port: 29991 },
      ])
      const report = await findTabs("figma", root)
      expect(report.profiles.map(({ name, relay, connected, tabs, sessions }) => ({ name, relay, connected, tabs, sessions }))).toEqual([
        {
          name: "work",
          relay: "running",
          connected: true,
          tabs: [
            { tabId: 12, url: "https://www.figma.com/file/abc", title: "Board", owner: "user", session: "figma", sessionDefault: true },
            { tabId: 13, url: "https://www.figma.com/login", title: "Figma login", owner: "relay", session: "figma" },
          ],
          sessions: ["figma"],
        },
        { name: "gone", relay: "stopped", connected: false, tabs: [], sessions: [] },
        { name: "far", relay: "stopped", connected: false, tabs: [], sessions: [] },
        { name: "bc", relay: "reserved", connected: false, tabs: [], sessions: [] },
        { name: "bcremote", relay: "reserved", connected: false, tabs: [], sessions: [] },
      ])
      expect(asked.some((url) => url.includes(`:${relay.port}/`))).toBe(true)
      expect(asked.filter((url) => /:(19990|29991)\//.test(url))).toEqual([])
      expect(report.matches.map((match) => match.next.replace(/^.*? --profile/, "--profile"))).toEqual([
        "--profile work execute --session figma 'return page.url()'",
        "--profile work execute --session figma --target-url https://www.figma.com/login 'return page.url()'",
      ])
      const text = formatFindReport(report)
      expect(text).toContain("work  port")
      expect(text).toContain("extension connected, 2 attached tabs  [Work (Profile 5)]")
      expect(text).toContain("gone  port")
      expect(text).toContain("relay not running")
      expect(text).toContain("bcremote  port 29991  not asked: Port 29991 is Mac port 19991 + 10000, browser-control's")
      expect(text).toContain('"figma" is attached on work (tab 12)')
    } finally {
      globalThis.fetch = realFetch
      relay.stop(true)
      proxy.stop(true)
    }
  })
})
