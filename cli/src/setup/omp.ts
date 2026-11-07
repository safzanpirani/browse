// The omp (oh-my-pi) client for browse: what `install --client omp` writes, and what uninstall and status read back.
// omp drives browse as a CLI from bash, guided by a skill, so install writes
//   launcher  <bin dir>/browse: a sh script that runs the installed CLI with the Node.js that ran install
//   skill     <skills dir>/browse/SKILL.md: the browse skill rewritten for the `browse` CLI
//   MCP       (with --mcp) a `browse` stdio server in <omp agent dir>/mcp.json, edited in place
// and records them in <data root>/omp.json, so uninstall removes exactly those even when the paths were overridden.
// Every file carries a marker (the launcher and skill a marker line, the MCP server the runtime fingerprint in its
// env); install refuses to overwrite and uninstall leaves alone anything without one.
// Defaults, each overridable by a flag, then an environment variable:
//   --bin-dir     OPENCODE_BROWSER_BIN_DIR     ~/.local/bin
//   --skills-dir  OPENCODE_BROWSER_SKILLS_DIR  ~/.agents/skills
//   --omp-dir     OPENCODE_BROWSER_OMP_DIR     $PI_CODING_AGENT_DIR, else ~/.omp/agent (omp's own override)
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from "jsonc-parser"

/** A browser the relay knows (browsers.json): the id agents pass as `--profile`/`browser`, and its name. */
export type KnownBrowser = { readonly id: string; readonly name?: string | undefined }

/** The launcher's file name, the skill's folder and the MCP server's name. */
export const NAME = "browse"
/** Marks the launcher and skill as written by install; neither is overwritten or removed without it. */
const MARKER = "Written by `opencode-browser install --client omp`; `opencode-browser uninstall` removes it. Install rewrites it."
/** Env key holding the runtime fingerprint; its presence marks a `browse` MCP server as this install's. */
const RUNTIME_KEY = "OPENCODE_BROWSER_RUNTIME"

export type OmpPaths = {
  launcher: string
  skill: string
  /** omp's user MCP config. */
  mcpConfig: string
  /** What install wrote, for uninstall and status. */
  manifest: string
}

/** What install recorded in the manifest. mcpConfig is set when it wrote the MCP server. */
export type OmpManifest = { launcher: string; skill: string; mcpConfig?: string }

type Env = Record<string, string | undefined>

export class OmpError extends Error {}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index !== -1) return args[index + 1]
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

/** omp's agent folder: where its mcp.json lives, and whose existence says omp is installed. */
export function ompAgentDir(args: readonly string[] = [], env: Env = process.env, home = homedir()): string {
  return path.resolve(flagValue(args, "--omp-dir") ?? env.OPENCODE_BROWSER_OMP_DIR ?? env.PI_CODING_AGENT_DIR ?? path.join(home, ".omp", "agent"))
}

/**
 * Where install writes for omp: flags, then environment variables, then where the last install wrote (so `update`,
 * which reruns install without these flags, rewrites the same files), then the defaults.
 */
export function ompPaths(dataDir: string, args: readonly string[] = [], env: Env = process.env, home = homedir()): OmpPaths {
  const manifest = path.join(dataDir, "omp.json")
  const recorded = readManifest(manifest)
  const binDir = flagValue(args, "--bin-dir") ?? env.OPENCODE_BROWSER_BIN_DIR
  const skillsDir = flagValue(args, "--skills-dir") ?? env.OPENCODE_BROWSER_SKILLS_DIR
  const agentDir = flagValue(args, "--omp-dir") ?? env.OPENCODE_BROWSER_OMP_DIR
  return {
    launcher: binDir ? path.resolve(binDir, NAME) : recorded?.launcher ?? path.join(home, ".local", "bin", NAME),
    skill: skillsDir ? path.resolve(skillsDir, NAME, "SKILL.md") : recorded?.skill ?? path.join(home, ".agents", "skills", NAME, "SKILL.md"),
    mcpConfig: agentDir ? path.resolve(agentDir, "mcp.json") : recorded?.mcpConfig ?? path.join(ompAgentDir([], env, home), "mcp.json"),
    manifest,
  }
}

/** Whether `--client omp` was given; any other `--client` value is an error (other agents are upstream's `--agent`). */
export function ompFlag(args: readonly string[]): boolean {
  const value = flagValue(args, "--client")
  if (value === undefined) return false
  if (value.trim() !== "omp") throw new OmpError(`--client takes omp (other agents: --agent <name>); got ${JSON.stringify(value)}.`)
  return true
}

/**
 * Whether install sets up omp: `--client omp`, else whether an earlier install did (it left a manifest), so `update`,
 * which reruns install without flags, keeps the launcher and skill current.
 */
export function ompRequested(args: readonly string[], manifest: string): boolean {
  return ompFlag(args) || readManifest(manifest) !== undefined
}

// ---- launcher -------------------------------------------------------------------------------------

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

export function launcherScript(runtime: { node: string; entry: string }): string {
  return [
    "#!/bin/sh",
    "# browse: the browse CLI, for omp and other agents that run commands.",
    `# ${MARKER}`,
    "# Commands the CLI prints (next steps, hints) start with this name.",
    `export OPENCODE_BROWSER_COMMAND=${NAME}`,
    `exec ${shellQuote(runtime.node)} ${shellQuote(runtime.entry)} "$@"`,
    "",
  ].join("\n")
}

/** "missing", "ours" (carries the marker), or "foreign" (anything else, including a symlink or a folder). */
function ownership(file: string): "missing" | "ours" | "foreign" {
  let stat
  try {
    stat = lstatSync(file)
  } catch {
    return "missing"
  }
  if (!stat.isFile()) return "foreign"
  try {
    // The marker on a line of its own: a `#` comment in the launcher, an HTML comment in the skill.
    const lines = readFileSync(file, "utf8").split(/\r?\n/)
    return lines.some((line) => line.replace(/^(#|<!--)\s*/, "").replace(/\s*-->$/, "") === MARKER) ? "ours" : "foreign"
  } catch {
    return "foreign"
  }
}

/** Writes `text` to a file install owns; "added", "updated" or "unchanged". The caller checked ownership. */
function writeOwned(file: string, text: string, mode?: number): "added" | "updated" | "unchanged" {
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined
  if (before === text) {
    if (mode !== undefined) chmodSync(file, mode)
    return "unchanged"
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text, mode === undefined ? {} : { mode })
  if (mode !== undefined) chmodSync(file, mode)
  return before === undefined ? "added" : "updated"
}

/** The launcher's target, read back from its exec line. */
export function launcherTarget(file: string): string | undefined {
  if (ownership(file) !== "ours") return undefined
  const exec = readFileSync(file, "utf8").split("\n").find((line) => line.startsWith("exec "))
  return exec?.match(/^exec '(?:[^']|'\\'')*' '((?:[^']|'\\'')*)'/)?.[1]?.replaceAll(`'\\''`, "'")
}

// ---- skill ----------------------------------------------------------------------------------------

/** Read before the upstream text: how its CLI and MCP references map to omp. */
const OMP_NOTE = `> **In omp:** run browse as shell commands through bash: \`${NAME} <command>\` is the browse CLI on PATH, and
> \`${NAME} --help\` / \`${NAME} <command> --help\` list every command and flag. Where this skill names an MCP tool
> (\`session_new\`, \`tabs_cleanup\`, \`settings { … }\`, \`network\`), run the matching \`${NAME}\` command instead; the
> \`${NAME}\` MCP server is optional. Pass \`--json\` when you need structured output. One relay drives every paired
> Chrome profile: \`${NAME} --profile <name> <command>\` (or \`OPENCODE_BROWSER_PROFILE=<name>\`) picks the profile's
> browser, and \`${NAME} find <site>\` says which one has the site. Profiles, habits and limits that matter in omp are in
> the last section.`

/**
 * Appended after the upstream text: the browsers the relay knew at install (rendered from its browsers.json, so the
 * table matches this machine), how to find a tab, the habits that saved agents turns, and the limits omp's scripts and
 * watchers hit.
 */
export function ompSection(browsers: readonly KnownBrowser[]): string {
  const table = browsers.length === 0
    ? `No browser had paired when this was installed; \`${NAME} pair\` prints a code for one.`
    : [
        "| --profile | Browser name |",
        "|---|---|",
        ...browsers.map((browser) => `| ${browser.id} | ${(browser.name ?? "").replaceAll("|", "\\|")} |`),
      ].join("\n")
  return `## Profiles, habits and limits (omp)

One relay (port 19988) drives every Chrome profile that paired with it. Each profile is a browser with an id, the
slug of the name set under **this browser → Name for agents** on its browse Options page. The browsers when this skill
was installed (\`${NAME} status\` and \`${NAME} pair --list\` show the live state):

${table}

- \`--profile <id>\` selects the browser a new session opens its tabs in (\`execute\`, \`session new\`, and \`settings\`);
  it also takes the browser's full name. Pass it on every command that should land in that profile; shell variables
  don't persist between calls. Without it a new session uses the default browser (the first that connected).
- A session stays in its browser. \`--profile\` on a session from another browser fails with "Session … belongs to
  browser …": start a new session instead.
- \`session adopt --tab-id\` into a new session needs the tab's \`--profile\` (\`${NAME} find\` prints the full command);
  without it the new session belongs to the default browser and a tab from another browser is refused.
- To add a profile: load browse there (the same unpacked \`dist/\` folder, or the store build), run \`${NAME} pair\`,
  enter the code on its Options page, and set its **Name for agents**.
- From another machine (ampere): the relay's HTTP API and CDP answer on 127.0.0.1 only, so ampere reaches this relay
  through one ssh tunnel on the same port (skill \`browse-remote\`, \`mac-relays.sh up\`). One browser connects to one
  relay, so every profile pairs with this Mac's relay.

### Find the tab first

\`\`\`bash
${NAME} find              # every browser: connection, attached tabs, sites its sessions visited
${NAME} find figma.com    # which browser has it attached, and the exact command to run next
\`\`\`

\`find\` starts no relay. A tab is usable only after the user clicks the toolbar button on it; when nothing matches,
\`find\` names the browsers whose sessions visited the site, so ask the user to open and attach it there.

### Habits that save turns

- Check the app's own signed-in account before acting, not the profile name. One browser profile can hold several
  Google accounts and web-app logins (2026-10-13: the insideiim profile's Gemini and claude.ai tabs were signed in as
  other accounts). Read the account from the page (\`a[aria-label^="Google Account"]\`, the app's account menu), and
  never use or override another person's account.
- Batch every step you can already name into one execute and end with what changed (\`snapshot({ delta: true })\`).
  Start a new call only when you need to see UI you haven't seen yet.
- Never sleep. Wait for what you expect (\`locator.waitFor()\`, \`page.waitForURL()\`), not \`waitForTimeout()\`.
- Give actions short timeouts in dynamic UI: \`click({ timeout: 5000 })\`. The 30 s default costs 30 s per miss.
- Return small values (counts, URLs, \`.slice(0, 3000)\` of text), and keep each execute under about a minute.
- Prefer an in-page request in an adopted tab (\`page.evaluate(() => fetch(...))\`) to opening a page. Keep tokens in
  the page and return only the fields you need.
- Search page text with word boundaries (\`\\bargon\\b\`; \`argon\` matched "jargon"). A label missing from the scripts
  may arrive by RPC; check a network capture before calling it absent.
- A watcher that depends on an attached tab stops when the Mac sleeps. It fails closed and says so, never pings.

### Limits and fixes (omp)

- Execute code has no \`fs\`: save with \`files.write()\`, or run the relay with \`OPENCODE_BROWSER_ALLOW_NODE=1\` for full
  Node.
- Tabs a session opened close after 10 untouched minutes. A watcher that runs longer adopts a tab the user shared
  (\`${NAME} session adopt\`), or the user sets \`${NAME} --profile <id> settings set idleMinutes=never\`.
- Human-like input paces every click and key: a mouse move takes up to about a second. A script that must be fast runs
  against a relay started with \`OPENCODE_BROWSER_HUMAN_INPUT=0\`.
- An execute stops after 60 s by default; \`${NAME} execute --timeout-ms <ms>\` changes it (0 disables).
- Stop the relay with \`${NAME} relay stop\`; it drains like \`relay restart\` and leaves tabs open.

| Symptom | Do this |
|---|---|
| Browser not connected | Run \`${NAME} find\`; use a browser that is connected, or tell the user which profile needs browse enabled. Run one relay-backed command, which waits up to 35 s for the extension; don't loop \`status\`. |
| "No connected browser is called …" | The profile isn't open, or its **Name for agents** differs. \`${NAME} status\` lists the connected ids. |
| Every execute on a session times out; \`session delete\`/\`reset\` say "timed out waiting for active execute" | A \`handoff()\` still waits for Continue, and killing the CLI doesn't cancel it. Ask the user to press Continue in that tab. For an OAuth popup, register no handoff: ask the user to sign in, then check \`page.url()\` in a fresh execute. |
| "Multiple attached pages ... match URL" | A session's own page sits next to the user's tab on that site. Delete that helper session, or adopt by \`--tab-id\` from \`${NAME} find\`. Never leave a helper page open between a watcher's steps. |
| A user tab is gone from \`${NAME} find\` after a session delete or closing a page | Cleanup can detach the user's tab. Run \`${NAME} find <site>\` after cleanup and ask the user to click the toolbar button again. |`
}

/**
 * The browse skill for omp: the upstream skill with a note mapping its MCP references to the CLI, a closing section on
 * profiles, habits and limits, and the marker.
 */
export function ompSkill(upstream: string, browsers: readonly KnownBrowser[]): string {
  const frontmatter = upstream.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0] ?? ""
  const body = upstream.slice(frontmatter.length).replace(/\brestarts opencode\b/g, "restarts omp")
  // The note goes after the title, or first when the skill has none.
  const title = body.match(/^# .*\n/m)
  const at = title ? (title.index ?? 0) + title[0].length : 0
  return `${frontmatter}<!-- ${MARKER} -->\n${body.slice(0, at)}\n${OMP_NOTE}\n${title ? "" : "\n"}${body.slice(at)}${body.endsWith("\n") ? "" : "\n"}\n${ompSection(browsers)}\n`
}

// ---- omp's mcp.json -------------------------------------------------------------------------------

type Server = { command?: unknown; args?: unknown; env?: unknown; [key: string]: unknown }

function readConfig(file: string): { text: string; servers: Record<string, Server> } | undefined {
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, "utf8")
  const errors: ParseError[] = []
  const config = parse(text, errors, { allowTrailingComma: false, disallowComments: true }) as unknown
  if (errors.length || typeof config !== "object" || config === null || Array.isArray(config))
    throw new OmpError(`${file} isn't a JSON object, so it was left alone. Fix it, then run install again.`)
  const servers = "mcpServers" in config ? config.mcpServers : undefined
  return { text, servers: typeof servers === "object" && servers !== null && !Array.isArray(servers) ? (servers as Record<string, Server>) : {} }
}

/**
 * A `browse` server install wrote: its env carries the runtime fingerprint. Install refreshes and uninstall removes
 * only these; any other `browse` server, even a hand-added one running browse, is the user's.
 */
function writtenServer(server: Server | undefined): boolean {
  const env = server?.env
  return typeof env === "object" && env !== null && RUNTIME_KEY in env && typeof env[RUNTIME_KEY] === "string"
}

/** The file's own indentation and line endings, so the edit matches the rest of it. */
function formatting(text: string): FormattingOptions {
  const indent = text.match(/^([ \t]+)\S/m)?.[1]
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  if (indent?.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol }
  return { insertSpaces: true, tabSize: indent?.length || 2, eol }
}

/**
 * The browse server: the existing entry with its command, args and fingerprint updated, so the user's own keys
 * (`env` variables, `timeout`, `enabled`) stay.
 */
export function mergedOmpServer(existing: Server | undefined, runtime: { node: string; entry: string; fingerprint: string }): Server {
  const env = typeof existing?.env === "object" && existing.env !== null && !Array.isArray(existing.env) ? existing.env : {}
  return { ...existing, command: runtime.node, args: [runtime.entry, "mcp"], env: { ...env, [RUNTIME_KEY]: runtime.fingerprint } }
}

/** Adds or refreshes the browse server in omp's mcp.json; every other byte of the file stays as it was. */
function configureOmpMcp(file: string, runtime: { node: string; entry: string; fingerprint: string }): string {
  const config = readConfig(file)
  const existing = config?.servers[NAME]
  const server = mergedOmpServer(existing, runtime)
  if (existing && isDeepStrictEqual(existing, server)) return `✓ omp MCP server "${NAME}" is up to date`
  const text = config?.text ?? "{}\n"
  const edits = modify(text, ["mcpServers", NAME], server, { formattingOptions: formatting(text) })
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, applyEdits(text, edits))
  return `✓ omp MCP server "${NAME}" ${existing ? "updated in" : "added to"} ${file} (restart omp to load it)`
}

function removeOmpMcp(file: string): boolean {
  const config = readConfig(file)
  if (!config || !writtenServer(config.servers[NAME])) return false
  writeFileSync(file, applyEdits(config.text, modify(config.text, ["mcpServers", NAME], undefined, { formattingOptions: formatting(config.text) })))
  return true
}

// ---- install, uninstall, status ------------------------------------------------------------------

export function readManifest(file: string): OmpManifest | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof value !== "object" || value === null || !("launcher" in value) || !("skill" in value)) return undefined
    const { launcher, skill } = value
    if (typeof launcher !== "string" || typeof skill !== "string") return undefined
    const mcpConfig = "mcpConfig" in value && typeof value.mcpConfig === "string" ? value.mcpConfig : undefined
    return { launcher, skill, ...(mcpConfig ? { mcpConfig } : {}) }
  } catch {
    return undefined
  }
}

/**
 * Throws OmpError listing everything install would refuse to overwrite, so setup can stop before writing anything
 * (install runs it first, as does installOmp).
 */
export function checkOmpInstallable(paths: OmpPaths, mcp: boolean): void {
  const conflicts: string[] = []
  if (process.platform === "win32") conflicts.push("The omp launcher is a sh script; install --client omp supports macOS and Linux.")
  if (ownership(paths.launcher) === "foreign")
    conflicts.push(`${paths.launcher} exists and wasn't written by install. Move it away, or pass --bin-dir <dir> to put the launcher elsewhere.`)
  if (ownership(paths.skill) === "foreign")
    conflicts.push(`${paths.skill} exists and wasn't written by install. Move it away, or pass --skills-dir <dir>.`)
  try {
    const existing = readConfig(paths.mcpConfig)?.servers[NAME]
    if (mcp && existing && !writtenServer(existing))
      conflicts.push(`${paths.mcpConfig} already has a "${NAME}" MCP server install didn't write. Rename or remove it, then run install again.`)
  } catch (error) {
    if (mcp) conflicts.push(errorMessage(error))
  }
  if (conflicts.length) throw new OmpError(["Not installed for omp:", ...conflicts.map((line) => `  ${line}`)].join("\n"))
}

/**
 * Installs the omp launcher and skill (and with `mcp`, the MCP server), refreshing an MCP server an earlier install
 * wrote even without `mcp`. Throws OmpError, having written nothing, when a file it would overwrite isn't its own.
 * Returns the lines to print.
 */
export function installOmp(options: {
  paths: OmpPaths
  runtime: { node: string; entry: string; fingerprint: string }
  /** The upstream SKILL.md text. */
  skill: string
  /** The browsers the relay knows, rendered as the skill's browser table. */
  browsers: readonly KnownBrowser[]
  mcp: boolean
}): string[] {
  const { paths, runtime } = options
  checkOmpInstallable(paths, options.mcp)
  const lines: string[] = []
  const launcher = writeOwned(paths.launcher, launcherScript(runtime), 0o755)
  lines.push(`✓ omp launcher ${launcher === "unchanged" ? "is up to date at" : `${launcher} at`} ${paths.launcher}`)
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.resolve(dir))
  if (!pathDirs.includes(path.dirname(paths.launcher))) lines.push(`! ${path.dirname(paths.launcher)} isn't on PATH; add it so \`${NAME}\` runs.`)
  const skill = writeOwned(paths.skill, ompSkill(options.skill, options.browsers))
  lines.push(`✓ omp skill ${skill === "unchanged" ? "is up to date at" : `${skill} at`} ${paths.skill}`)
  const previous = readManifest(paths.manifest)
  // An MCP server written before is kept current, so an update doesn't leave omp running the old runtime.
  const ownedBefore = (() => {
    try {
      return writtenServer(readConfig(paths.mcpConfig)?.servers[NAME])
    } catch {
      return false
    }
  })()
  const mcp = options.mcp || (ownedBefore && previous?.mcpConfig === paths.mcpConfig)
  if (mcp) lines.push(configureOmpMcp(paths.mcpConfig, runtime))
  const manifest: OmpManifest = { launcher: paths.launcher, skill: paths.skill, ...(mcp ? { mcpConfig: paths.mcpConfig } : {}) }
  mkdirSync(path.dirname(paths.manifest), { recursive: true })
  writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + "\n")
  return lines
}

/** Removes what install wrote at `paths` (by default where it recorded writing), each only if it carries the marker. */
export function uninstallOmp(paths: OmpPaths): string[] {
  const lines: string[] = []
  if (ownership(paths.launcher) === "ours") {
    rmSync(paths.launcher, { force: true })
    lines.push(`✓ Removed the omp launcher ${paths.launcher}`)
  }
  if (ownership(paths.skill) === "ours") {
    rmSync(paths.skill, { force: true })
    // The skill's folder goes too, unless the user keeps something else in it.
    const folder = path.dirname(paths.skill)
    if (readdirSync(folder).length === 0) rmdirSync(folder)
    lines.push(`✓ Removed the omp skill ${paths.skill}`)
  }
  try {
    if (removeOmpMcp(paths.mcpConfig)) lines.push(`✓ Removed the omp MCP server "${NAME}" from ${paths.mcpConfig}`)
  } catch (error) {
    lines.push(`! ${errorMessage(error)}`)
  }
  rmSync(paths.manifest, { force: true })
  return lines
}

/** Status lines for omp; none when omp was neither set up nor is installed here. */
export function ompStatus(paths: OmpPaths, ompInstalled: boolean): string[] {
  const manifest = readManifest(paths.manifest)
  if (!manifest && !ompInstalled) return []
  if (!manifest) return ["omp:       not set up. Run install with --client omp."]
  const target = launcherTarget(manifest.launcher)
  const mcp = (() => {
    if (!manifest.mcpConfig) return "MCP server not configured (install --client omp --mcp adds it)"
    try {
      return writtenServer(readConfig(manifest.mcpConfig)?.servers[NAME]) ? `MCP server "${NAME}" in ${manifest.mcpConfig}` : `MCP server missing from ${manifest.mcpConfig}`
    } catch (error) {
      return errorMessage(error)
    }
  })()
  return [
    `omp:       launcher ${target ? `${manifest.launcher} → ${target}${existsSync(target) ? "" : " (missing; run install again)"}` : `missing at ${manifest.launcher}`}`,
    `           skill ${ownership(manifest.skill) === "ours" ? manifest.skill : `missing at ${manifest.skill}`}`,
    `           ${mcp}`,
  ]
}
