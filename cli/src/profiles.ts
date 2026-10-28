// Browser profiles, each with its own relay. A relay takes one extension connection, so driving several browser
// profiles at once needs one relay per profile and one copy of the unpacked extension per profile, pinned to that
// relay's port by a relay-port.json in the copy (src/background/relay-port.ts reads it).
//   profiles add <name> [--port P] [--label T]  copy the built extension to <data root>/profiles/<name>/extension,
//                                               pin its port, pair it, and record it in <data root>/profiles.json
//   profiles list [--json]                      each profile's port, folder and live relay/extension status
//   profiles remove <name>                      forget a profile and delete the folder add created
//   profiles sync [--no-reload]                 re-copy the current build and pairing code into every profile's folder
// `--profile <name>` (or OPENCODE_BROWSER_PROFILE) on any command selects that profile's relay: it sets
// OPENCODE_BROWSER_PORT. Without either, commands use OPENCODE_BROWSER_PORT or the default 19988.
// Every copy has the same extension ID (the manifest key), so a browser profile loads at most one of them.
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs"
import path from "node:path"
import { cliCommand, dataRoot } from "./paths.ts"
import { ensurePrivateDirectory, extensionPairingFileName, pairingCode, relayAuthorization, writeExtensionPairing } from "./relay-secrets.ts"

/** The file in a copy that pins its relay port (src/background/relay-port.ts). */
export const relayPortFileName = "relay-port.json"
/** Where `add` picks a port when none is given. */
export const profilePortRange = { first: 19960, last: 19966 } as const
/** The relays browser-control runs on this machine; a profile never takes one. */
export const reservedPortRange = { first: 19989, last: 19995 } as const
/** The default relay: the extension folder install sets up dials it, so a copy pinned to it would compete. */
const defaultPort = 19988
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

export type ProfileRecord = {
  name: string
  port: number
  label?: string
  /** The extension copy to load unpacked in this browser profile. */
  extension: string
  createdAt: string
}

export type ProfileStatus = ProfileRecord & {
  /** running: answered with this install's token; foreign: another install's relay (it refused the token). */
  relay: "running" | "stopped" | "foreign"
  connected: boolean
  /** Tabs the relay has attached (its root targets). */
  attachedTabs: number
  sessions: number
  folderMissing: boolean
}

type Env = Record<string, string | undefined>

export class ProfileError extends Error {}

const lockWaitMs = 10_000
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** The pid recorded in a lock file; undefined while it is still being written. */
function lockOwner(lock: string): number | undefined {
  const pid = Number.parseInt(readFileSync(lock, "utf8"), 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Runs a registry change (read, pick a port, copy, publish) under one lock file, so concurrent `profiles add`
 * calls in separate processes never pick the same port or drop each other's records. A dead owner's lock is
 * refused, never taken over: two waiters could both see it dead, and the second would delete the first's new lock.
 */
function withProfilesLock<A>(root: string, change: () => A): A {
  ensurePrivateDirectory(root)
  const lock = `${profilesFile(root)}.lock`
  const deadline = Date.now() + lockWaitMs
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600)
      try {
        writeSync(fd, `${process.pid}\n`)
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let owner: number | undefined
      try {
        owner = lockOwner(lock)
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue
        throw readError
      }
      if (owner !== undefined && !processAlive(owner))
        throw new ProfileError(`${lock} was left by pid ${owner}, which is no longer running. Delete it if no browse command is running, then retry.`)
      if (Date.now() > deadline) throw new ProfileError(`Another browse process (pid ${owner ?? "unknown"}) holds ${lock}. Retry when it finishes.`)
      sleepSync(50)
    }
  }
  try {
    return change()
  } finally {
    // Remove only our own lock, in case it was deleted by hand and another process took it.
    try {
      if (lockOwner(lock) === process.pid) rmSync(lock, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

export const profilesFile = (root = dataRoot()) => path.join(root, "profiles.json")
const profileFolder = (root: string, name: string) => path.join(path.resolve(root), "profiles", name)
/** A profile's extension copy. Always derived from its name, so no edit to profiles.json can point a write elsewhere. */
const extensionFolder = (root: string, name: string) => path.join(profileFolder(root, name), "extension")

/** The recorded profiles; none when the file is missing. A malformed file is an error, never silently replaced. */
export function readProfiles(root = dataRoot()): ProfileRecord[] {
  const file = profilesFile(root)
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    throw new ProfileError(`${file} isn't valid JSON. Fix or remove it.`)
  }
  const list = typeof parsed === "object" && parsed !== null && "profiles" in parsed ? parsed.profiles : undefined
  if (!Array.isArray(list)) throw new ProfileError(`${file} has no "profiles" list. Fix or remove it.`)
  return list.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) throw new ProfileError(`${file} has an invalid profile entry.`)
    const { name, port, label, createdAt }: Record<string, unknown> = Object.fromEntries(Object.entries(entry))
    if (typeof name !== "string" || !NAME.test(name) || typeof port !== "number")
      throw new ProfileError(`${file} has an invalid profile entry.`)
    return {
      name,
      port,
      ...(typeof label === "string" ? { label } : {}),
      extension: extensionFolder(root, name),
      createdAt: typeof createdAt === "string" ? createdAt : "",
    }
  })
}

function writeProfiles(root: string, profiles: ProfileRecord[]) {
  const file = profilesFile(root)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`)
  renameSync(temporary, file)
}

/** The first port in 19960-19966 no profile uses. */
export function nextFreePort(profiles: readonly ProfileRecord[]): number | undefined {
  for (let port: number = profilePortRange.first; port <= profilePortRange.last; port++)
    if (!profiles.some((profile) => profile.port === port)) return port
  return undefined
}

/** Why `port` can't be a new profile's, or undefined when it can. */
export function portProblem(port: number, profiles: readonly ProfileRecord[]): string | undefined {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return `Port ${port} isn't a valid port (1024-65535).`
  if (port >= reservedPortRange.first && port <= reservedPortRange.last)
    return `Port ${port} is in ${reservedPortRange.first}-${reservedPortRange.last}, browser-control's relays. Pick another.`
  if (port === defaultPort) return `Port ${port} is the default relay's, which the extension folder install set up dials. Pick another.`
  const owner = profiles.find((profile) => profile.port === port)
  if (owner) return `Port ${port} is already profile "${owner.name}"'s.`
  return undefined
}

/**
 * Replaces `destination` with a copy of the built extension in `source`, pinned to `port` and paired with `code`. The
 * copy is assembled beside it and swapped in, so a browser reading the folder never sees it half-written.
 */
function writeCopy(source: string, destination: string, port: number, code: string) {
  const staging = `${destination}.${process.pid}.tmp`
  rmSync(staging, { recursive: true, force: true })
  cpSync(source, staging, {
    recursive: true,
    // The source's own pairing file and any pinned port are replaced by this copy's.
    filter: (file) => ![extensionPairingFileName, relayPortFileName].includes(path.basename(file)),
  })
  writeFileSync(path.join(staging, relayPortFileName), `${JSON.stringify({ port })}\n`)
  writeExtensionPairing(staging, code)
  rmSync(destination, { recursive: true, force: true })
  renameSync(staging, destination)
}

function requireBuild(source: string) {
  if (!existsSync(path.join(source, "manifest.json")))
    throw new ProfileError(`${source} has no built extension. Run install (or \`bun run build\` in a checkout) first.`)
}

export type AddOptions = { root?: string; name: string; port?: number | undefined; label?: string | undefined; source: string; code?: string }

/** Adds a profile; `picked` says the port was chosen because none was given. */
export function addProfile(options: AddOptions): { profile: ProfileRecord; picked: boolean } {
  const root = options.root ?? dataRoot()
  const { name } = options
  if (!NAME.test(name)) throw new ProfileError(`"${name}" isn't a valid profile name: use letters, digits, - and _ (at most 40).`)
  return withProfilesLock(root, () => addProfileLocked(root, options))
}

function addProfileLocked(root: string, options: AddOptions): { profile: ProfileRecord; picked: boolean } {
  const { name } = options
  const profiles = readProfiles(root)
  if (profiles.some((profile) => profile.name === name)) throw new ProfileError(`Profile "${name}" already exists.`)
  const port = options.port ?? nextFreePort(profiles)
  if (port === undefined)
    throw new ProfileError(`Every port in ${profilePortRange.first}-${profilePortRange.last} is taken. Pass --port <port>.`)
  const problem = portProblem(port, profiles)
  if (problem) throw new ProfileError(problem)
  requireBuild(options.source)
  const folder = profileFolder(root, name)
  const extension = extensionFolder(root, name)
  if (existsSync(extension)) throw new ProfileError(`${extension} exists but isn't a recorded profile. Move it away, then add again.`)
  ensurePrivateDirectory(root)
  ensurePrivateDirectory(path.join(root, "profiles"))
  mkdirSync(folder, { recursive: true })
  writeCopy(options.source, extension, port, options.code ?? pairingCode(root))
  const profile: ProfileRecord = { name, port, ...(options.label ? { label: options.label } : {}), extension, createdAt: new Date().toISOString() }
  writeProfiles(root, [...profiles, profile])
  return { profile, picked: options.port === undefined }
}

/** Forgets a profile and deletes the copy add made; anything else in its folder stays. */
export function removeProfile(name: string, root = dataRoot()): ProfileRecord {
  return withProfilesLock(root, () => removeProfileLocked(name, root))
}

function removeProfileLocked(name: string, root: string): ProfileRecord {
  const profiles = readProfiles(root)
  const profile = profiles.find((entry) => entry.name === name)
  if (!profile) throw new ProfileError(`No profile "${name}". \`${cliCommand("profiles list")}\` shows them.`)
  rmSync(profile.extension, { recursive: true, force: true })
  const folder = profileFolder(root, name)
  if (existsSync(folder) && readdirSync(folder).length === 0) rmdirSync(folder)
  writeProfiles(root, profiles.filter((entry) => entry !== profile))
  return profile
}

/**
 * Refreshes every profile's copy: the current build from `source` when there is one, else only the pairing code and
 * pinned port in the copies there are. Install calls this after pairing, so copies never keep a stale code.
 */
export function syncProfileCopies(source: string, code: string, root = dataRoot()): ProfileRecord[] {
  return withProfilesLock(root, () => syncProfileCopiesLocked(source, code, root))
}

function syncProfileCopiesLocked(source: string, code: string, root: string): ProfileRecord[] {
  const profiles = readProfiles(root)
  const built = existsSync(path.join(source, "manifest.json"))
  for (const profile of profiles) {
    if (built) writeCopy(source, profile.extension, profile.port, code)
    else if (existsSync(path.join(profile.extension, "manifest.json"))) {
      writeFileSync(path.join(profile.extension, relayPortFileName), `${JSON.stringify({ port: profile.port })}\n`)
      writeExtensionPairing(profile.extension, code)
    }
  }
  return profiles
}

/**
 * install's hook (setup.ts pairUnpacked): refreshes the profile copies after pairing, so none keeps a stale code or an
 * old build. A broken profiles.json is reported, never fatal to install.
 */
export function refreshProfileCopies(source: string, code: string, root = dataRoot()): string[] {
  try {
    const profiles = syncProfileCopies(source, code, root)
    return profiles.length ? [`✓ Refreshed ${profiles.length} profile cop${profiles.length === 1 ? "y" : "ies"} (\`${cliCommand("profiles sync")}\` reloads connected ones)`] : []
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error
    return [`! Profile copies not refreshed: ${error.message}`]
  }
}

const relayRequest = (root: string, port: number, pathname: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { authorization: relayAuthorization(root), ...init.headers },
    signal: AbortSignal.timeout(1_500),
  })

/** Asks each profile's relay (never starting one) whether its extension is connected and what it has attached. */
export function profileStatuses(profiles: readonly ProfileRecord[], root = dataRoot()): Promise<ProfileStatus[]> {
  return Promise.all(profiles.map(async (profile): Promise<ProfileStatus> => {
    const base = { ...profile, connected: false, attachedTabs: 0, sessions: 0, folderMissing: !existsSync(path.join(profile.extension, "manifest.json")) }
    const response = await relayRequest(root, profile.port, "/extension/status").catch(() => undefined)
    if (!response) return { ...base, relay: "stopped" }
    if (!response.ok) return { ...base, relay: "foreign" }
    const status: unknown = await response.json().catch(() => undefined)
    if (typeof status !== "object" || status === null) return { ...base, relay: "foreign" }
    const connected = "connected" in status && status.connected === true
    const attachedTabs = "activeTargets" in status && typeof status.activeTargets === "number" ? status.activeTargets : 0
    const sessions = "sessions" in status && Array.isArray(status.sessions) ? status.sessions.length : 0
    return { ...base, relay: "running", connected, attachedTabs, sessions }
  }))
}

/**
 * The port `--profile <name>` (or OPENCODE_BROWSER_PROFILE) selects, and the arguments without the flag. The flag
 * wins over the environment; OPENCODE_BROWSER_PROFILE and a different OPENCODE_BROWSER_PORT conflict. Arguments
 * after `--` are left alone (they belong to `secrets run`'s command).
 */
export function selectProfile(args: readonly string[], env: Env, root = dataRoot()): { args: string[]; profile?: ProfileRecord } {
  const rest: string[] = []
  let flag: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      rest.push(...args.slice(index))
      break
    }
    if (arg === "--profile") {
      flag = args[++index]
      if (flag === undefined || flag.startsWith("-")) throw new ProfileError("--profile needs a profile name.")
    } else if (arg.startsWith("--profile=")) flag = arg.slice("--profile=".length)
    else rest.push(arg)
  }
  const name = flag ?? env.OPENCODE_BROWSER_PROFILE
  if (!name) return { args: rest }
  const profile = readProfiles(root).find((entry) => entry.name === name)
  if (!profile) throw new ProfileError(`No profile "${name}". \`${cliCommand("profiles list")}\` shows them.`)
  if (flag === undefined && env.OPENCODE_BROWSER_PORT && Number(env.OPENCODE_BROWSER_PORT) !== profile.port)
    throw new ProfileError(`OPENCODE_BROWSER_PROFILE=${name} is port ${profile.port}, but OPENCODE_BROWSER_PORT is ${env.OPENCODE_BROWSER_PORT}. Unset one.`)
  return { args: rest, profile }
}

/**
 * main.ts's hook: applies `--profile` / OPENCODE_BROWSER_PROFILE to this process before any command reads
 * OPENCODE_BROWSER_PORT. The managed relay inherits both variables, so it resolves to the same port.
 */
export function applyProfileSelection(argv = process.argv, env = process.env): void {
  try {
    const selection = selectProfile(argv.slice(2), env)
    argv.splice(2, argv.length - 2, ...selection.args)
    if (!selection.profile) return
    env.OPENCODE_BROWSER_PROFILE = selection.profile.name
    env.OPENCODE_BROWSER_PORT = String(selection.profile.port)
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index !== -1) return args[index + 1]
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

/** The positional arguments: everything but flags and the values of `valued` flags. */
function positionals(args: readonly string[], valued: readonly string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (valued.includes(arg)) index++
    else if (!arg.startsWith("-")) result.push(arg)
  }
  return result
}

const log = (line = "") => {
  process.stdout.write(`${line}\n`)
}

function describeStatus(status: ProfileStatus) {
  if (status.relay === "stopped") return "relay stopped"
  if (status.relay === "foreign") return "port held by another relay (it refused this install's token)"
  if (!status.connected) return "relay running, extension not connected"
  return `connected, ${status.attachedTabs} attached tab${status.attachedTabs === 1 ? "" : "s"}, ${status.sessions} session${status.sessions === 1 ? "" : "s"}`
}

const USAGE = `Usage:
  profiles add <name> [--port <port>] [--label <text>]
  profiles list [--json]
  profiles remove <name>
  profiles sync [--no-reload]`

/** `opencode-browser profiles …`. `source` is the built extension folder copies are made from. */
export async function runProfilesCommand(args: readonly string[], source: string, root = dataRoot()): Promise<void> {
  const [subcommand, name] = positionals(args, ["--port", "--label"])
  try {
    if (subcommand === "add") {
      if (!name) throw new ProfileError(`profiles add needs a name.\n${USAGE}`)
      const portFlag = flagValue(args, "--port")
      const port = portFlag === undefined ? undefined : Number(portFlag)
      if (portFlag !== undefined && !Number.isInteger(port)) throw new ProfileError(`--port ${portFlag} isn't a port number.`)
      const { profile, picked } = addProfile({ root, name, port, label: flagValue(args, "--label"), source })
      log(`✓ Added profile "${profile.name}" on port ${profile.port}${picked ? ` (the next free one in ${profilePortRange.first}-${profilePortRange.last})` : ""}`)
      log(`  Extension folder: ${profile.extension}`)
      log("")
      log("In the browser profile it should drive, open the extensions page, turn on Developer mode, remove any other")
      log("OpenCode Browser there (every copy has the same ID), and Load unpacked from that folder. Then:")
      log(`  ${cliCommand(`--profile ${profile.name} status`)}`)
      return
    }
    if (subcommand === "list") {
      const statuses = await profileStatuses(readProfiles(root), root)
      if (args.includes("--json")) return log(JSON.stringify(statuses, null, 2))
      if (statuses.length === 0) return log(`No profiles. Add one with \`${cliCommand("profiles add <name>")}\`.`)
      for (const status of statuses) {
        log(`${status.name}${status.label ? ` (${status.label})` : ""}  port ${status.port}  ${describeStatus(status)}`)
        log(`  ${status.extension}${status.folderMissing ? "  (missing: run `profiles sync`)" : ""}`)
      }
      return
    }
    if (subcommand === "remove") {
      if (!name) throw new ProfileError(`profiles remove needs a name.\n${USAGE}`)
      const profile = removeProfile(name, root)
      log(`✓ Removed profile "${profile.name}" (port ${profile.port}) and ${profile.extension}`)
      log("Remove the extension from that browser profile too. A relay running on that port keeps running until it exits.")
      return
    }
    if (subcommand === "sync") {
      requireBuild(source)
      const profiles = syncProfileCopies(source, pairingCode(root), root)
      if (profiles.length === 0) return log("No profiles to sync.")
      const reload = !args.includes("--no-reload")
      const statuses = reload ? await profileStatuses(profiles, root) : []
      for (const profile of profiles) {
        const connected = statuses.find((status) => status.name === profile.name)?.connected
        // A running extension keeps the old build until it reloads; ask the connected ones to.
        const reloaded = connected
          ? (await relayRequest(root, profile.port, "/extension/reload", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }).catch(() => undefined))?.ok === true
          : false
        log(`✓ Synced "${profile.name}" (port ${profile.port})${reloaded ? ", reloading its extension" : connected ? "; reload its extension on the extensions page" : ""}`)
      }
      return
    }
    throw new ProfileError(USAGE)
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
