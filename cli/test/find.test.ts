import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { findTabs, formatFindReport, matchQuery, sessionHistory, sessionNameFor, type FoundBrowser } from "../src/find.ts"
import { relayToken } from "../src/relay/secrets.ts"

const temps: string[] = []
afterAll(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-find-"))
  temps.push(dir)
  return dir
}

function journal(journals: string, session: string, entries: object[]) {
  fs.mkdirSync(path.join(journals, session), { recursive: true })
  fs.writeFileSync(path.join(journals, session, "journal.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\nnot json\n`)
}

const browser = (id: string, overrides: Partial<FoundBrowser> = {}): FoundBrowser => ({
  id,
  name: id,
  default: false,
  connected: true,
  tabs: [],
  sessions: [],
  visited: [],
  ...overrides,
})

describe("sessionHistory", () => {
  test("counts each browser's hosts by the entry's browser, else by the session catalog, and lists every session id", () => {
    const root = tempDir()
    const journals = path.join(root, "sessions")
    journal(journals, "a", [
      { browser: "work", startUrl: "about:blank", endUrl: "https://www.figma.com/file/1", navigations: ["https://figma.com/x"] },
      { browser: "work", endUrl: "https://mail.google.com/u/0" },
      { browser: "work", endUrl: "http://127.0.0.1:3000/" },
    ])
    journal(journals, "legacy", [{ endUrl: "https://figma.com/" }])
    const catalog = path.join(root, "sessions.json")
    fs.writeFileSync(catalog, JSON.stringify({ version: 1, sessions: [{ id: "legacy", browser: "patty" }, { id: "no-journal" }] }))
    const history = sessionHistory({ journals, catalog })
    expect(history.visited.get("work")).toEqual(["figma.com", "mail.google.com"])
    expect(history.visited.get("patty")).toEqual(["figma.com"])
    expect([...history.sessionIds].sort()).toEqual(["a", "legacy", "no-journal"])
  })
})

describe("matchQuery", () => {
  test("names the browser in the command for a user tab, and suggests a free session id", () => {
    const browsers = [
      browser("work", { tabs: [{ tabId: 7, url: "https://www.figma.com/file/1", title: "Design", owner: "user" }] }),
      browser("patty", { visited: ["figma.com"], sessions: ["figma"] }),
    ]
    const result = matchQuery(browsers, "figma", new Set(["figma-2"]))
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.browser).toBe("work")
    expect(result.matches[0]!.next).toContain("--profile work session adopt --tab-id 7 --session figma-3")
    expect(result.visitedBy).toEqual(["patty"])
  })

  test("advises where to open a site nothing has attached", () => {
    const result = matchQuery([browser("patty", { visited: ["figma.com"] })], "figma.com", new Set())
    expect(result.matches).toEqual([])
    expect(result.advice).toContain("Sessions in patty visited it before")
  })

  test("continues a session on its default page without --profile", () => {
    const browsers = [browser("work", { tabs: [{ tabId: 3, url: "https://x.com/home", title: "X", owner: "relay", session: "x", sessionDefault: true }] })]
    expect(matchQuery(browsers, "x.com", new Set()).matches[0]!.next).toContain("execute --session x 'return page.url()'")
  })
})

test("sessionNameFor numbers a taken name", () => {
  expect(sessionNameFor("https://www.figma.com/file", new Set(["figma"]))).toBe("figma-2")
})

describe("findTabs", () => {
  test("groups the relay's tabs by browser and starts no relay when none runs", async () => {
    const root = tempDir()
    const token = relayToken(root)
    const server = http.createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) return response.writeHead(401).end()
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        connected: true,
        browsers: [
          { id: "work", name: "work", default: true, connected: true, tabs: 1 },
          { id: "patty", name: "Patty", default: false, connected: true, tabs: 1 },
        ],
        sessions: [{ id: "s1", browser: "patty", targetId: "t2" }],
        targets: [
          { id: "t1", type: "page", url: "https://a.example/", title: "A", tabId: 1, owner: "user", browser: "work" },
          { id: "t2", type: "page", url: "https://b.example/", title: "B", tabId: 2, owner: "relay", opencodeBrowserSessionId: "s1", browser: "patty" },
        ],
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    try {
      const report = await findTabs("b.example", { port, root, journals: path.join(root, "sessions") })
      expect(report.relay).toBe("running")
      expect(report.browsers.map((entry) => [entry.id, entry.tabs.map((tab) => tab.tabId)])).toEqual([["work", [1]], ["patty", [2]]])
      expect(report.browsers[1]!.tabs[0]!.sessionDefault).toBe(true)
      expect(report.matches[0]!.browser).toBe("patty")
      expect(formatFindReport(report)).toContain("patty  connected, 1 attached tab  [Patty]")
    } finally {
      server.close()
    }
    const stopped = await findTabs(undefined, { port, root, journals: path.join(root, "sessions") })
    expect(stopped.relay).toBe("stopped")
  })
})
