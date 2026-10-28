import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  addProfile,
  applyProfileSelection,
  ProfileError,
  profilesFile,
  profileStatuses,
  readProfiles,
  refreshProfileCopies,
  removeProfile,
  selectProfile,
  syncProfileCopies,
} from "../src/profiles.ts"
import { relayToken } from "../src/relay-secrets.ts"

const CODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const OTHER = "ZYXWVTSRQPNMKJHGFEDCBA9876543210"

const temps: string[] = []
afterAll(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A temp data root and a fake built extension (with a checkout's own pairing file and a stray port file). */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-profiles-"))
  temps.push(dir)
  const root = path.join(dir, "data")
  const source = path.join(dir, "dist")
  fs.mkdirSync(path.join(source, "assets"), { recursive: true })
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ name: "OpenCode Browser" }))
  fs.writeFileSync(path.join(source, "assets", "background.js"), "build 1")
  fs.writeFileSync(path.join(source, "relay-pairing.json"), JSON.stringify({ code: OTHER }))
  fs.writeFileSync(path.join(source, "relay-port.json"), JSON.stringify({ port: 1 }))
  return { root, source }
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"))
const refusal = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileError)
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected a ProfileError")
}

describe("profiles add", () => {
  test("copies the build, pins the port, pairs the copy and records it", () => {
    const { root, source } = sandbox()
    const { profile, picked } = addProfile({ root, name: "work", label: "Chrome: Work", source, code: CODE })
    expect(picked).toBe(true)
    expect(profile.port).toBe(19960)
    expect(profile.extension).toBe(path.join(root, "profiles", "work", "extension"))
    expect(fs.readFileSync(path.join(profile.extension, "assets", "background.js"), "utf8")).toBe("build 1")
    expect(readJson(path.join(profile.extension, "relay-port.json"))).toEqual({ port: 19960 })
    expect(readJson(path.join(profile.extension, "relay-pairing.json"))).toEqual({ code: CODE })
    expect(readJson(profilesFile(root)).profiles).toEqual([
      { name: "work", port: 19960, label: "Chrome: Work", extension: profile.extension, createdAt: profile.createdAt },
    ])
    expect(readProfiles(root)).toEqual([profile])
  })

  test("picks the next free port in 19960-19966, and takes an explicit one", () => {
    const { root, source } = sandbox()
    addProfile({ root, name: "a", source, code: CODE, port: 19961 })
    expect(addProfile({ root, name: "b", source, code: CODE }).profile.port).toBe(19960)
    expect(addProfile({ root, name: "c", source, code: CODE }).profile.port).toBe(19962)
    expect(addProfile({ root, name: "d", source, code: CODE, port: 29960 }).picked).toBe(false)
  })

  test("refuses browser-control's ports, the default port, taken ports and names, and bad names", () => {
    const { root, source } = sandbox()
    addProfile({ root, name: "work", source, code: CODE })
    for (const port of [19989, 19992, 19995]) expect(refusal(() => addProfile({ root, name: "x", port, source, code: CODE }))).toMatch(/browser-control/)
    expect(refusal(() => addProfile({ root, name: "x", port: 19988, source, code: CODE }))).toMatch(/default relay/)
    expect(refusal(() => addProfile({ root, name: "x", port: 19960, source, code: CODE }))).toMatch(/profile "work"/)
    expect(refusal(() => addProfile({ root, name: "x", port: 80, source, code: CODE }))).toMatch(/valid port/)
    expect(refusal(() => addProfile({ root, name: "work", port: 19961, source, code: CODE }))).toMatch(/already exists/)
    for (const name of ["../up", "a b", "-x", ""]) expect(refusal(() => addProfile({ root, name, source, code: CODE }))).toMatch(/valid profile name/)
    expect(readProfiles(root).map((profile) => profile.name)).toEqual(["work"])
    expect(fs.readdirSync(path.join(root, "profiles"))).toEqual(["work"])
  })

  test("asks for --port once the range is full", () => {
    const { root, source } = sandbox()
    for (let index = 0; index < 7; index++) addProfile({ root, name: `p${index}`, source, code: CODE })
    expect(refusal(() => addProfile({ root, name: "p7", source, code: CODE }))).toMatch(/Pass --port/)
  })

  test("concurrent adds in separate processes get distinct ports and both stay recorded", async () => {
    const { root, source } = sandbox()
    const module = path.join(import.meta.dir, "../src/profiles.ts")
    const script = (name: string) =>
      `const { addProfile } = await import(${JSON.stringify(module)}); addProfile({ root: ${JSON.stringify(root)}, name: ${JSON.stringify(name)}, source: ${JSON.stringify(source)}, code: ${JSON.stringify(CODE)} })`
    const children = ["a", "b", "c", "d"].map((name) => Bun.spawn([process.execPath, "-e", script(name)], { stderr: "pipe" }))
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0, 0])
    const profiles = readProfiles(root)
    expect(profiles.map((profile) => profile.name).sort()).toEqual(["a", "b", "c", "d"])
    expect(new Set(profiles.map((profile) => profile.port)).size).toBe(4)
    expect(fs.existsSync(`${profilesFile(root)}.lock`)).toBe(false)
  })

  test("refuses a lock left by a dead process instead of taking it over", async () => {
    const { root, source } = sandbox()
    const dead = Bun.spawn(["true"])
    await dead.exited
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(`${profilesFile(root)}.lock`, `${dead.pid}\n`)
    expect(refusal(() => addProfile({ root, name: "work", source, code: CODE }))).toMatch(/no longer running/)
    expect(fs.existsSync(`${profilesFile(root)}.lock`)).toBe(true)
    expect(readProfiles(root)).toEqual([])
  })

  test("needs a built extension, and leaves a folder it didn't record alone", () => {
    const { root, source } = sandbox()
    expect(refusal(() => addProfile({ root, name: "work", source: path.join(source, "assets"), code: CODE }))).toMatch(/no built extension/)
    fs.mkdirSync(path.join(root, "profiles", "work", "extension"), { recursive: true })
    expect(refusal(() => addProfile({ root, name: "work", source, code: CODE }))).toMatch(/isn't a recorded profile/)
  })
})

describe("profiles remove", () => {
  test("deletes the copy and the record, keeping anything else in the profile's folder", () => {
    const { root, source } = sandbox()
    const work = addProfile({ root, name: "work", source, code: CODE }).profile
    const home = addProfile({ root, name: "home", source, code: CODE }).profile
    fs.writeFileSync(path.join(root, "profiles", "home", "notes.txt"), "mine")
    removeProfile("work", root)
    expect(fs.existsSync(path.join(root, "profiles", "work"))).toBe(false)
    removeProfile("home", root)
    expect(fs.existsSync(home.extension)).toBe(false)
    expect(fs.readFileSync(path.join(root, "profiles", "home", "notes.txt"), "utf8")).toBe("mine")
    expect(readProfiles(root)).toEqual([])
    expect(fs.existsSync(work.extension)).toBe(false)
    expect(refusal(() => removeProfile("work", root))).toMatch(/No profile "work"/)
  })

  test("never follows an extension path edited into profiles.json", () => {
    const { root, source } = sandbox()
    addProfile({ root, name: "work", source, code: CODE })
    const file = profilesFile(root)
    const data = readJson(file)
    data.profiles[0].extension = source
    fs.writeFileSync(file, JSON.stringify(data))
    removeProfile("work", root)
    expect(fs.existsSync(path.join(source, "manifest.json"))).toBe(true)
  })
})

describe("profiles sync", () => {
  test("re-copies the current build and pairing code, keeping each copy's port", () => {
    const { root, source } = sandbox()
    const work = addProfile({ root, name: "work", source, code: CODE }).profile
    const home = addProfile({ root, name: "home", port: 19965, source, code: CODE }).profile
    fs.writeFileSync(path.join(source, "assets", "background.js"), "build 2")
    fs.writeFileSync(path.join(source, "new.js"), "new")
    fs.writeFileSync(path.join(work.extension, "stale.js"), "gone after sync")
    expect(syncProfileCopies(source, OTHER, root).map((profile) => profile.name)).toEqual(["work", "home"])
    for (const profile of [work, home]) {
      expect(fs.readFileSync(path.join(profile.extension, "assets", "background.js"), "utf8")).toBe("build 2")
      expect(fs.existsSync(path.join(profile.extension, "new.js"))).toBe(true)
      expect(readJson(path.join(profile.extension, "relay-port.json"))).toEqual({ port: profile.port })
      expect(readJson(path.join(profile.extension, "relay-pairing.json"))).toEqual({ code: OTHER })
    }
    expect(fs.existsSync(path.join(work.extension, "stale.js"))).toBe(false)
  })

  test("without a build, refreshes only the pairing code and port in the copies there are", () => {
    const { root, source } = sandbox()
    const work = addProfile({ root, name: "work", source, code: CODE }).profile
    syncProfileCopies(path.join(root, "nowhere"), OTHER, root)
    expect(fs.readFileSync(path.join(work.extension, "assets", "background.js"), "utf8")).toBe("build 1")
    expect(readJson(path.join(work.extension, "relay-pairing.json"))).toEqual({ code: OTHER })
  })

  test("install's hook reports a broken profiles.json instead of failing", () => {
    const { root, source } = sandbox()
    expect(refreshProfileCopies(source, CODE, root)).toEqual([])
    addProfile({ root, name: "work", source, code: CODE })
    expect(refreshProfileCopies(source, CODE, root)).toEqual([expect.stringMatching(/Refreshed 1 profile copy/)])
    fs.writeFileSync(profilesFile(root), "{")
    expect(refreshProfileCopies(source, CODE, root)).toEqual([expect.stringMatching(/not refreshed: .*isn't valid JSON/)])
  })
})

describe("profiles list", () => {
  test("asks each relay with the token and reports running, stopped and foreign relays", async () => {
    const { root, source } = sandbox()
    const token = relayToken(root)
    const ours = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) =>
        request.headers.get("authorization") === `Bearer ${token}` && new URL(request.url).pathname === "/extension/status"
          ? Response.json({ connected: true, activeTargets: 2, sessions: [{ id: "a" }, { id: "b" }, { id: "c" }] })
          : new Response("no", { status: 401 }),
    })
    const foreign = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "unauthorized" }, { status: 401 }) })
    const stopped = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
    const stoppedPort = stopped.port!
    stopped.stop(true)
    try {
      addProfile({ root, name: "live", port: ours.port!, source, code: CODE })
      addProfile({ root, name: "other", port: foreign.port!, source, code: CODE })
      const gone = addProfile({ root, name: "gone", port: stoppedPort, source, code: CODE }).profile
      fs.rmSync(gone.extension, { recursive: true })
      const statuses = await profileStatuses(readProfiles(root), root)
      expect(statuses.map(({ name, relay, connected, attachedTabs, sessions, folderMissing }) => ({ name, relay, connected, attachedTabs, sessions, folderMissing }))).toEqual([
        { name: "live", relay: "running", connected: true, attachedTabs: 2, sessions: 3, folderMissing: false },
        { name: "other", relay: "foreign", connected: false, attachedTabs: 0, sessions: 0, folderMissing: false },
        { name: "gone", relay: "stopped", connected: false, attachedTabs: 0, sessions: 0, folderMissing: true },
      ])
    } finally {
      ours.stop(true)
      foreign.stop(true)
    }
  })
})

describe("--profile", () => {
  test("resolves a profile's port from the flag (stripped from the arguments) or the environment", () => {
    const { root, source } = sandbox()
    addProfile({ root, name: "work", port: 19963, source, code: CODE })
    expect(selectProfile(["--profile", "work", "status", "--json"], {}, root)).toMatchObject({ args: ["status", "--json"], profile: { port: 19963 } })
    expect(selectProfile(["execute", "--profile=work", "1"], {}, root)).toMatchObject({ args: ["execute", "1"], profile: { port: 19963 } })
    expect(selectProfile(["status"], { OPENCODE_BROWSER_PROFILE: "work" }, root)).toMatchObject({ args: ["status"], profile: { port: 19963 } })
    // The flag wins over the environment.
    expect(selectProfile(["--profile", "work", "status"], { OPENCODE_BROWSER_PORT: "19970" }, root).profile?.port).toBe(19963)
  })

  test("leaves arguments alone without one, and after --", () => {
    const { root } = sandbox()
    expect(selectProfile(["status"], {}, root)).toEqual({ args: ["status"] })
    const args = ["secrets", "run", "x", "--", "cmd", "--profile", "y"]
    expect(selectProfile(args, {}, root)).toEqual({ args })
  })

  test("refuses unknown profiles, a missing name, and a conflicting OPENCODE_BROWSER_PORT", () => {
    const { root, source } = sandbox()
    addProfile({ root, name: "work", port: 19963, source, code: CODE })
    expect(refusal(() => selectProfile(["--profile", "nope", "status"], {}, root))).toMatch(/No profile "nope"/)
    expect(refusal(() => selectProfile(["status", "--profile"], {}, root))).toMatch(/needs a profile name/)
    expect(refusal(() => selectProfile(["status"], { OPENCODE_BROWSER_PROFILE: "work", OPENCODE_BROWSER_PORT: "19970" }, root))).toMatch(/Unset one/)
    expect(selectProfile(["status"], { OPENCODE_BROWSER_PROFILE: "work", OPENCODE_BROWSER_PORT: "19963" }, root).profile?.port).toBe(19963)
  })

  test("takes an email or browser profile folder from exactly one profile's label", () => {
    const { root, source } = sandbox()
    addProfile({ root, name: "patty", port: 19963, label: "Patty (Profile 2, june@example.com)", source, code: CODE })
    addProfile({ root, name: "safzan", port: 19962, label: "Safzan (Default, s@example.com)", source, code: CODE })
    addProfile({ root, name: "other", port: 19965, label: "Safzan (Profile 6, o@example.com)", source, code: CODE })
    expect(selectProfile(["--profile", "june@example.com", "status"], {}, root).profile?.name).toBe("patty")
    expect(selectProfile(["--profile=PROFILE 2", "status"], {}, root).profile?.name).toBe("patty")
    expect(selectProfile(["status"], { OPENCODE_BROWSER_PROFILE: "default" }, root).profile?.name).toBe("safzan")
    // A name wins over a label part, and a substring of a part is no match.
    expect(selectProfile(["--profile", "safzan", "status"], {}, root).profile?.port).toBe(19962)
    const ambiguous = refusal(() => selectProfile(["--profile", "Safzan", "status"], {}, root))
    expect(ambiguous).toMatch(/"Safzan" is in the label of safzan and other/)
    expect(ambiguous).toContain("  patty  Patty (Profile 2, june@example.com)")
    const unknown = refusal(() => selectProfile(["--profile", "june@example", "status"], {}, root))
    expect(unknown).toMatch(/No profile "june@example" \(by name or label\)/)
    expect(unknown).toContain("  other  Safzan (Profile 6, o@example.com)")
  })

  describe("applyProfileSelection", () => {
    const saved = process.env.OPENCODE_BROWSER_HOME
    afterEach(() => {
      if (saved === undefined) delete process.env.OPENCODE_BROWSER_HOME
      else process.env.OPENCODE_BROWSER_HOME = saved
    })

    test("sets OPENCODE_BROWSER_PORT (and the profile, for a managed relay) and strips the flag", () => {
      const { root, source } = sandbox()
      addProfile({ root, name: "work", port: 19964, source, code: CODE })
      process.env.OPENCODE_BROWSER_HOME = root
      const argv = ["node", "cli.mjs", "--profile", "work", "session", "list"]
      const env: Record<string, string | undefined> = { OPENCODE_BROWSER_PORT: "19988" }
      applyProfileSelection(argv, env)
      expect(argv).toEqual(["node", "cli.mjs", "session", "list"])
      expect(env).toEqual({ OPENCODE_BROWSER_PORT: "19964", OPENCODE_BROWSER_PROFILE: "work" })
    })

    test("keeps the default port when no profile is selected", () => {
      const { root } = sandbox()
      process.env.OPENCODE_BROWSER_HOME = root
      const argv = ["node", "cli.mjs", "status"]
      const env: Record<string, string | undefined> = {}
      applyProfileSelection(argv, env)
      expect(argv).toEqual(["node", "cli.mjs", "status"])
      expect(env).toEqual({})
    })
  })
})
