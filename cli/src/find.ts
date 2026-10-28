// `opencode-browser find [query] [--json]`: one call that shows, for every profile, whether its relay runs, whether
// its extension is connected, and the tabs attached to it. With a query (a URL fragment, host or title word) it also
// lists the matching tabs, the profiles whose sessions visited that host before (from the session journals), and the
// exact command to run next. Observational: it asks relays that already run and reads files; it never starts a relay.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { cliCommand, dataRoot } from "./paths.ts"
import { probeRelay, ProfileError, readProfiles, reservedPortProblem, type ProfileRecord } from "./profiles.ts"

export type FoundTab = {
  tabId?: number
  url: string
  title: string
  /** user: a tab the user shared with the toolbar button; relay: a page a session opened. */
  owner?: "relay" | "user"
  /** The session that has adopted or opened it. */
  session?: string
  crashed?: boolean
  protectedUi?: boolean
}

export type FoundProfile = {
  name: string
  port: number
  label?: string
  relay: "running" | "stopped" | "foreign" | "reserved"
  connected: boolean
  tabs: FoundTab[]
  sessions: string[]
  /** Hosts this profile's sessions visited, most visits first. */
  visited: string[]
}

export type FindMatch = { profile: string; tab: FoundTab; next: string }

export type FindReport = {
  query?: string
  profiles: FoundProfile[]
  matches: FindMatch[]
  /** Profiles whose sessions visited the query's host before. */
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
 * Hosts each profile's sessions visited, most visits first, from `<root>/sessions/<id>/journal.jsonl`. An entry names
 * its relay port; an older one without it counts for every profile whose session catalog lists its session.
 */
export function visitedHosts(profiles: readonly ProfileRecord[], root = dataRoot()): Map<string, string[]> {
  const byPort = new Map(profiles.map((profile) => [profile.port, profile.name]))
  const catalogs = new Map<string, string[]>()
  for (const profile of profiles) {
    let ids: unknown
    try {
      ids = JSON.parse(readFileSync(path.join(root, "relays", String(profile.port), "sessions.json"), "utf8")).sessions
    } catch {
      continue
    }
    if (!Array.isArray(ids)) continue
    for (const entry of ids) {
      if (typeof entry?.id !== "string") continue
      catalogs.set(entry.id, [...(catalogs.get(entry.id) ?? []), profile.name])
    }
  }
  const counts = new Map<string, Map<string, number>>()
  const sessionsDir = path.join(root, "sessions")
  for (const id of existsSync(sessionsDir) ? readdirSync(sessionsDir) : []) {
    let text: string
    try {
      text = readFileSync(path.join(sessionsDir, id, "journal.jsonl"), "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      let entry: { port?: unknown; startUrl?: unknown; endUrl?: unknown; navigations?: unknown }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const owner = typeof entry.port === "number" ? byPort.get(entry.port) : undefined
      const names = owner ? [owner] : typeof entry.port === "number" ? [] : (catalogs.get(id) ?? [])
      const urls = [entry.startUrl, entry.endUrl, ...(Array.isArray(entry.navigations) ? entry.navigations : [])]
      const hosts = new Set(urls.flatMap((url) => (typeof url === "string" ? (webHost(url) ?? []) : [])))
      for (const name of names) {
        const tally = counts.get(name) ?? new Map<string, number>()
        counts.set(name, tally)
        for (const host of hosts) tally.set(host, (tally.get(host) ?? 0) + 1)
      }
    }
  }
  return new Map([...counts].map(([name, tally]) => [name, [...tally].sort((a, b) => b[1] - a[1]).map(([host]) => host)]))
}

/** A session id made from the query: its host's first label, or its first word ("figma.com/file/x" gives figma). */
export function sessionNameFor(query: string): string {
  const base = query.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[./:?#\s]/)[0] ?? ""
  return base.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "tab"
}

/** The tab's next command: continue its session, else adopt it (a user tab), else select it for one execute. */
function nextCommand(profile: string, tab: FoundTab, query: string): string {
  const prefix = `--profile ${profile}`
  if (tab.session) return cliCommand(`${prefix} execute --session ${quoted(tab.session)} 'return page.url()'`)
  if (tab.owner === "user" && tab.tabId !== undefined)
    return cliCommand(`${prefix} session adopt --tab-id ${tab.tabId} --session ${sessionNameFor(query)}`)
  return cliCommand(`${prefix} execute --target-url ${quoted(tab.url)} 'return page.url()'`)
}

/** The query's part of the report: matching tabs (URL or title), profiles that visited its host, and advice. */
export function matchQuery(profiles: readonly FoundProfile[], query: string): Pick<FindReport, "matches" | "visitedBy" | "advice"> {
  const wanted = query.toLowerCase()
  const matches = profiles.flatMap((profile) =>
    profile.tabs
      .filter((tab) => tab.url.toLowerCase().includes(wanted) || tab.title.toLowerCase().includes(wanted))
      .map((tab) => ({ profile: profile.name, tab, next: nextCommand(profile.name, tab, query) })),
  )
  const wantedHost = wanted.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? ""
  const visitedBy = wantedHost
    ? profiles
        .filter((profile) => profile.visited.some((host) => host.includes(wantedHost) || wantedHost === host || wantedHost.endsWith(`.${host}`)))
        .map((profile) => profile.name)
    : []
  if (matches.length > 0) return { matches, visitedBy }
  const rerun = `\`${cliCommand(`find ${quoted(query)}`)}\``
  const where = visitedBy.length > 0
    ? `Sessions on ${visitedBy.join(", ")} visited it before. Ask the user to open it in that browser profile`
    : "No session visited it before. Ask the user which browser profile is signed in, to open it there,"
  return { matches, visitedBy, advice: `No attached tab matches "${query}". ${where} and click the OpenCode Browser toolbar button on the tab; then run ${rerun} again.` }
}

/** Reads each profile's relay (never starting one) and journals into a report. */
export async function findTabs(query: string | undefined, root = dataRoot()): Promise<FindReport> {
  const records = readProfiles(root)
  const visited = visitedHosts(records, root)
  const profiles = await Promise.all(records.map(async (record): Promise<FoundProfile> => {
    const probe = await probeRelay(record.port, root)
    const base = {
      name: record.name,
      port: record.port,
      ...(record.label ? { label: record.label } : {}),
      relay: probe.relay,
      visited: visited.get(record.name) ?? [],
    }
    if (probe.relay !== "running") return { ...base, connected: false, tabs: [], sessions: [] }
    const { status } = probe
    const targets: unknown[] = Array.isArray(status.targets) ? status.targets : []
    const tabs = targets.flatMap((target): FoundTab[] => {
      if (typeof target !== "object" || target === null) return []
      const t: Record<string, unknown> = Object.fromEntries(Object.entries(target))
      if (t.type !== "page") return []
      return [{
        ...(typeof t.tabId === "number" ? { tabId: t.tabId } : {}),
        url: typeof t.url === "string" ? t.url : "",
        title: typeof t.title === "string" ? t.title : "",
        ...(t.owner === "user" || t.owner === "relay" ? { owner: t.owner } : {}),
        ...(typeof t.opencodeBrowserSessionId === "string" ? { session: t.opencodeBrowserSessionId } : {}),
        ...(t.crashed === true ? { crashed: true } : {}),
        ...(t.protectedUi === true ? { protectedUi: true } : {}),
      }]
    })
    const sessionList: unknown[] = Array.isArray(status.sessions) ? status.sessions : []
    const sessions = sessionList.flatMap((session) =>
      typeof session === "object" && session !== null && "id" in session && typeof session.id === "string" ? [session.id] : [],
    )
    return { ...base, connected: status.connected === true, tabs, sessions }
  }))
  if (!query) return { profiles, matches: [], visitedBy: [] }
  return { query, profiles, ...matchQuery(profiles, query) }
}

function describeRelay(profile: FoundProfile): string {
  if (profile.relay === "stopped") return "relay not running"
  if (profile.relay === "foreign") return "port held by another relay (it refused this install's token)"
  if (profile.relay === "reserved") return `not asked: ${reservedPortProblem(profile.port)} Fix its port in profiles.json`
  if (!profile.connected) return "relay running, extension not connected"
  const count = profile.tabs.length
  return `extension connected, ${count} attached tab${count === 1 ? "" : "s"}`
}

export function formatFindReport(report: FindReport): string {
  const lines: string[] = []
  for (const profile of report.profiles) {
    lines.push(`${profile.name}  port ${profile.port}  ${describeRelay(profile)}${profile.label ? `  [${profile.label}]` : ""}`)
    for (const tab of profile.tabs) {
      const flags = `${tab.crashed ? " crashed" : ""}${tab.protectedUi ? " protected-ui" : ""}`
      const id = tab.tabId === undefined ? "" : `tab=${tab.tabId}`
      const session = tab.session ? `session=${tab.session}` : ""
      lines.push(`    ${(tab.owner ?? "").padEnd(5)} ${id.padEnd(14)} ${session.padEnd(24)} ${(tab.url || "about:blank").slice(0, 110)}${flags}`)
      if (tab.title && tab.title !== tab.url) lines.push(`          ${tab.title.slice(0, 110)}`)
    }
    if (profile.visited.length > 0) lines.push(`    visited before: ${profile.visited.slice(0, 8).join(", ")}`)
  }
  if (report.query) {
    lines.push("")
    for (const match of report.matches)
      lines.push(`"${report.query}" is attached on ${match.profile}${match.tab.tabId === undefined ? "" : ` (tab ${match.tab.tabId})`}: ${match.tab.url}`, `  ${match.next}`)
    if (report.advice) lines.push(report.advice)
  }
  return lines.join("\n")
}

const USAGE = "Usage: find [query] [--json]"

/** `opencode-browser find …`. */
export async function runFindCommand(args: readonly string[], root = dataRoot()): Promise<void> {
  const flags = args.filter((arg) => arg.startsWith("-"))
  const words = args.filter((arg) => !arg.startsWith("-"))
  if (flags.some((flag) => flag !== "--json") || words.length > 1) {
    process.stderr.write(`${USAGE}\n`)
    process.exitCode = 1
    return
  }
  let report: FindReport
  try {
    report = await findTabs(words[0], root)
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (flags.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  if (report.profiles.length === 0) {
    process.stdout.write(`No profiles. \`${cliCommand("profiles list")}\` and \`${cliCommand("profiles add <name>")}\` set them up.\n`)
    return
  }
  process.stdout.write(`${formatFindReport(report)}\n`)
}
