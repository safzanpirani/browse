// `browse find [query] [--json]`: one call that shows, for every browser paired with the relay, whether it is
// connected and the tabs attached to it. With a query (a URL fragment, host or title word) it also lists the matching
// tabs, the browsers whose sessions visited that host before (from the session journals), and the exact command to run
// next. Observational: it asks a relay that already runs and reads files; it never starts one.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { cliCommand, dataRoot } from "./paths.ts"
import { relayAuthorization } from "./relay/secrets.ts"
import { defaultJournalBaseDir } from "./session-manager/journal.ts"
import { defaultSessionCatalogPath } from "./session-manager/catalog.ts"

export type FoundTab = {
  tabId?: number
  url: string
  title: string
  /** user: a tab the user shared with the toolbar button; relay: a page a session opened. */
  owner?: "relay" | "user"
  /** The session that has adopted or opened it. */
  session?: string
  /** It is that session's default page (the relay's recorded default target), the one `--session` alone drives. */
  sessionDefault?: boolean
  crashed?: boolean
  protectedUi?: boolean
}

export type FoundBrowser = {
  id: string
  name: string
  default: boolean
  connected: boolean
  tabs: FoundTab[]
  sessions: string[]
  /** Hosts this browser's sessions visited, most visits first. */
  visited: string[]
}

/** A matching tab and the command to run next; `note` says when that command can't name exactly this tab. */
export type FindMatch = { browser: string; tab: FoundTab; next: string; note?: string }

export type FindReport = {
  query?: string
  relay: "running" | "stopped" | "foreign"
  browsers: FoundBrowser[]
  matches: FindMatch[]
  /** Browsers whose sessions visited the query's host before. */
  visitedBy: string[]
  /** What to do when no tab matches. */
  advice?: string
}

const quoted = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`)

/** The host a URL names, without `www.`; undefined for non-web URLs, local hosts and redacted placeholders. */
function webHost(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  const host = parsed.hostname.replace(/^www\./, "")
  if (!/^[a-z0-9.-]+$/.test(host) || host === "localhost" || /^127\.|^0\.0\.0\.0$/.test(host)) return undefined
  return host
}

/**
 * What the state records about past sessions: the hosts each browser's sessions visited, most visits first, from
 * `<journals>/<id>/journal.jsonl`, and every session id in use or with a journal (a new id must avoid them all, or it
 * would join a live session or an old journal). A journal entry names its browser; an older one counts for the browser
 * the session catalog records for its session.
 */
export function sessionHistory(options: { readonly journals: string; readonly catalog: string }): { visited: Map<string, string[]>; sessionIds: Set<string> } {
  const owners = new Map<string, string>()
  try {
    const sessions: unknown = JSON.parse(readFileSync(options.catalog, "utf8")).sessions
    for (const entry of Array.isArray(sessions) ? sessions : []) {
      if (typeof entry?.id === "string") owners.set(entry.id, typeof entry.browser === "string" ? entry.browser : "")
    }
  } catch {
    // No catalog yet: journals that name their browser still count.
  }
  const sessionIds = new Set(owners.keys())
  const counts = new Map<string, Map<string, number>>()
  for (const id of existsSync(options.journals) ? readdirSync(options.journals) : []) {
    sessionIds.add(id)
    let text: string
    try {
      text = readFileSync(path.join(options.journals, id, "journal.jsonl"), "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      let entry: { browser?: unknown; startUrl?: unknown; endUrl?: unknown; navigations?: unknown }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const browser = typeof entry.browser === "string" ? entry.browser : owners.get(id)
      if (!browser) continue
      const urls = [entry.startUrl, entry.endUrl, ...(Array.isArray(entry.navigations) ? entry.navigations : [])]
      const tally = counts.get(browser) ?? new Map<string, number>()
      counts.set(browser, tally)
      for (const host of new Set(urls.flatMap((url) => (typeof url === "string" ? (webHost(url) ?? []) : []))))
        tally.set(host, (tally.get(host) ?? 0) + 1)
    }
  }
  const visited = new Map([...counts].map(([browser, tally]) => [browser, [...tally].sort((a, b) => b[1] - a[1]).map(([host]) => host)]))
  return { visited, sessionIds }
}

/**
 * A session id made from the query (its host's first label, or its first word: "figma.com/file/x" gives figma) that
 * isn't in `taken`, numbered when it is (figma-2). Adopting into an existing session would close that session's page.
 */
export function sessionNameFor(query: string, taken: ReadonlySet<string>): string {
  const base = query.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[./:?#\s]/)[0] ?? ""
  const name = base.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "tab"
  let candidate = name
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}-${n}`
  return candidate
}

/**
 * The tab's next command: continue its session, else adopt it into a new session of its browser (a user tab), else
 * select it for one execute in a new session of its browser. `--session` alone drives the session's default page, so a
 * tab in a session gets `--target-url` with its URL unless the relay reports it as the default; when another attached
 * tab contains that URL too, nothing names it exactly and a note says so.
 */
function nextStep(browser: FoundBrowser, tab: FoundTab, query: string, taken: Set<string>): Pick<FindMatch, "next" | "note"> {
  const prefix = `--profile ${quoted(browser.id)}`
  const unique = browser.tabs.filter((other) => other.url.includes(tab.url)).length === 1
  const tabName = tab.tabId === undefined ? "this tab" : `tab ${tab.tabId}`
  if (tab.session) {
    const session = `--session ${quoted(tab.session)}`
    if (tab.sessionDefault) return { next: cliCommand(`${prefix} execute ${session} 'return page.url()'`) }
    if (unique) return { next: cliCommand(`${prefix} execute ${session} --target-url ${quoted(tab.url)} 'return page.url()'`) }
    return {
      next: cliCommand(`${prefix} execute ${session} 'return context.pages().map((p) => p.url())'`),
      note: `${tabName} isn't session ${tab.session}'s default page, and another attached tab contains its URL, so no selector names it alone: --session drives the default page (or opens one). Pick it from context.pages().`,
    }
  }
  if (tab.owner === "user" && tab.tabId !== undefined) {
    const session = sessionNameFor(query, taken)
    taken.add(session)
    return { next: cliCommand(`${prefix} session adopt --tab-id ${tab.tabId} --session ${session}`) }
  }
  const next = cliCommand(`${prefix} execute --target-url ${quoted(tab.url)} 'return page.url()'`)
  return unique ? { next } : { next, note: `Another tab contains this URL, so --target-url won't pick ${tabName} alone; use a longer URL.` }
}

/**
 * The query's part of the report: matching tabs (URL or title), browsers that visited its host, and advice.
 * `sessionIds` are the ids already in use (sessionHistory); a suggested new session avoids them and every live one.
 */
export function matchQuery(browsers: readonly FoundBrowser[], query: string, sessionIds: ReadonlySet<string>): Pick<FindReport, "matches" | "visitedBy" | "advice"> {
  const wanted = query.toLowerCase()
  const taken = new Set([...sessionIds, ...browsers.flatMap((browser) => [...browser.sessions, ...browser.tabs.flatMap((tab) => tab.session ?? [])])])
  const matches = browsers.flatMap((browser) =>
    browser.tabs
      .filter((tab) => tab.url.toLowerCase().includes(wanted) || tab.title.toLowerCase().includes(wanted))
      .map((tab): FindMatch => ({ browser: browser.id, tab, ...nextStep(browser, tab, query, taken) })),
  )
  const wantedHost = wanted.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? ""
  const visitedBy = wantedHost
    ? browsers
        .filter((browser) => browser.visited.some((host) => host.includes(wantedHost) || wantedHost.endsWith(`.${host}`)))
        .map((browser) => browser.id)
    : []
  if (matches.length > 0) return { matches, visitedBy }
  const rerun = `\`${cliCommand(`find ${quoted(query)}`)}\``
  const where = visitedBy.length > 0
    ? `Sessions in ${visitedBy.join(", ")} visited it before. Ask the user to open it in that browser profile`
    : "No session visited it before. Ask the user which browser profile is signed in, to open it there,"
  return { matches, visitedBy, advice: `No attached tab matches "${query}". ${where} and click the browse toolbar button on the tab; then run ${rerun} again.` }
}

type StatusJson = {
  connected?: unknown
  browsers?: unknown
  sessions?: unknown
  targets?: unknown
}

/** The relay's /extension/status, without starting it: undefined when nothing listens, "foreign" when it refuses the token. */
async function relayStatus(port: number, root: string): Promise<StatusJson | "foreign" | undefined> {
  let authorization: string
  try {
    authorization = relayAuthorization(root)
  } catch {
    return undefined
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/extension/status`, { headers: { authorization }, signal: AbortSignal.timeout(5_000) })
    if (response.status === 401 || response.status === 403) return "foreign"
    if (!response.ok) return "foreign"
    return (await response.json()) as StatusJson
  } catch {
    return undefined
  }
}

/** The JSON objects in a list the relay sent; anything else is skipped. */
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): Record<string, unknown>[] =>
    typeof item === "object" && item !== null && !Array.isArray(item) ? [Object.fromEntries(Object.entries(item))] : [])
}

/** Reads the relay (never starting it) and the journals into a report. */
export async function findTabs(query: string | undefined, options: { readonly port?: number; readonly root?: string; readonly journals?: string } = {}): Promise<FindReport> {
  const port = options.port ?? (Number(process.env.OPENCODE_BROWSER_PORT) || 19988)
  const root = options.root ?? dataRoot()
  const history = sessionHistory({
    journals: options.journals ?? defaultJournalBaseDir(),
    catalog: options.root ? path.join(options.root, "relays", String(port), "sessions.json") : defaultSessionCatalogPath(port),
  })
  const status = await relayStatus(port, root)
  if (status === undefined || status === "foreign") {
    const relay = status === "foreign" ? "foreign" : "stopped"
    return { ...(query ? { query } : {}), relay, browsers: [], matches: [], visitedBy: [] }
  }
  const sessionList = records(status.sessions)
  // Each session's default page, by target id: a tab is the default only when the relay says so.
  const defaults = new Map(sessionList.flatMap((session) => (typeof session.id === "string" && typeof session.targetId === "string" ? [[session.id, session.targetId] as const] : [])))
  const browserList = records(status.browsers)
  const defaultId = browserList.find((browser) => browser.default === true)?.id
  const targets = records(status.targets)
  const browsers = browserList.flatMap((entry): FoundBrowser[] => {
    if (typeof entry.id !== "string") return []
    const id = entry.id
    const tabs = targets
      .filter((target) => target.type === "page" && (target.browser ?? defaultId) === id)
      .map((target): FoundTab => {
        const session = typeof target.opencodeBrowserSessionId === "string" ? target.opencodeBrowserSessionId : undefined
        return {
          ...(typeof target.tabId === "number" ? { tabId: target.tabId } : {}),
          url: typeof target.url === "string" ? target.url : "",
          title: typeof target.title === "string" ? target.title : "",
          ...(target.owner === "user" || target.owner === "relay" ? { owner: target.owner } : {}),
          ...(session ? { session } : {}),
          ...(session && typeof target.id === "string" && defaults.get(session) === target.id ? { sessionDefault: true } : {}),
          ...(target.crashed === true ? { crashed: true } : {}),
          ...(target.protectedUi === true ? { protectedUi: true } : {}),
        }
      })
    return [{
      id,
      name: typeof entry.name === "string" ? entry.name : id,
      default: entry.default === true,
      connected: entry.connected === true,
      tabs,
      sessions: sessionList.flatMap((session) => (session.browser === id && typeof session.id === "string" ? [session.id] : [])),
      visited: history.visited.get(id) ?? [],
    }]
  })
  if (!query) return { relay: "running", browsers, matches: [], visitedBy: [] }
  return { query, relay: "running", browsers, ...matchQuery(browsers, query, history.sessionIds) }
}

export function formatFindReport(report: FindReport): string {
  const lines: string[] = []
  for (const browser of report.browsers) {
    const count = browser.tabs.length
    const state = browser.connected ? `connected, ${count} attached tab${count === 1 ? "" : "s"}` : "not connected"
    lines.push(`${browser.id}${browser.default ? " (default)" : ""}  ${state}  [${browser.name}]`)
    for (const tab of browser.tabs) {
      const flags = `${tab.crashed ? " crashed" : ""}${tab.protectedUi ? " protected-ui" : ""}`
      const id = tab.tabId === undefined ? "" : `tab=${tab.tabId}`
      const session = tab.session ? `session=${tab.session}` : ""
      lines.push(`    ${(tab.owner ?? "").padEnd(5)} ${id.padEnd(14)} ${session.padEnd(24)} ${(tab.url || "about:blank").slice(0, 110)}${flags}`)
      if (tab.title && tab.title !== tab.url) lines.push(`          ${tab.title.slice(0, 110)}`)
    }
    if (browser.visited.length > 0) lines.push(`    visited before: ${browser.visited.slice(0, 8).join(", ")}`)
  }
  if (report.query) {
    lines.push("")
    for (const match of report.matches) {
      lines.push(`"${report.query}" is attached in ${match.browser}${match.tab.tabId === undefined ? "" : ` (tab ${match.tab.tabId})`}: ${match.tab.url}`, `  ${match.next}`)
      if (match.note) lines.push(`  ${match.note}`)
    }
    if (report.advice) lines.push(report.advice)
  }
  return lines.join("\n")
}

const USAGE = "Usage: find [query] [--json]"

/** `browse find …`. */
export async function runFindCommand(args: readonly string[]): Promise<void> {
  const flags = args.filter((arg) => arg.startsWith("-"))
  const words = args.filter((arg) => !arg.startsWith("-"))
  if (flags.some((flag) => flag !== "--json") || words.length > 1) {
    process.stderr.write(`${USAGE}\n`)
    process.exitCode = 1
    return
  }
  const report = await findTabs(words[0])
  if (flags.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  if (report.relay === "stopped") {
    process.stdout.write(`The relay isn't running; any relay-backed command (\`${cliCommand("status")}\`) starts it.\n`)
    return
  }
  if (report.relay === "foreign") {
    process.stdout.write("The relay on this port refused this install's token; it belongs to another browse install.\n")
    process.exitCode = 1
    return
  }
  if (report.browsers.length === 0) {
    process.stdout.write(`No browser is connected. \`${cliCommand("pair")}\` pairs one.\n`)
    return
  }
  process.stdout.write(`${formatFindReport(report)}\n`)
}
