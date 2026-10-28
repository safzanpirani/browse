import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  clientFlag,
  installOmp,
  launcherTarget,
  OmpError,
  ompPaths,
  ompSkill,
  ompStatus,
  resolveClients,
  uninstallOmp,
  type OmpPaths,
} from "../src/omp.ts"

const upstreamSkill = fs.readFileSync(path.join(import.meta.dir, "..", "skills", "browse", "SKILL.md"), "utf8")
const runtime = { node: "/opt/node 22/bin/node", entry: "/src/it's/cli/dist/cli.mjs", fingerprint: "0123456789abcdef" }

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Every omp path under one temp folder, as the overrides would put them. */
function sandbox(): OmpPaths & { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-omp-"))
  temps.push(root)
  const paths = ompPaths(path.join(root, "data"), ["--bin-dir", path.join(root, "bin"), "--skills-dir", path.join(root, "skills"), "--omp-dir", path.join(root, "omp")], {}, root)
  return { ...paths, root }
}

const install = (paths: OmpPaths, mcp = false) => installOmp({ paths, runtime, skill: upstreamSkill, mcp })
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"))

describe("launcher", () => {
  test("is an executable sh script that runs the installed entry with install's node", () => {
    const paths = sandbox()
    install(paths)
    const script = fs.readFileSync(paths.launcher, "utf8")
    expect(script.startsWith("#!/bin/sh\n")).toBe(true)
    expect(script).toContain(`exec '/opt/node 22/bin/node' '/src/it'\\''s/cli/dist/cli.mjs' "$@"`)
    expect(fs.statSync(paths.launcher).mode & 0o111).not.toBe(0)
    expect(launcherTarget(paths.launcher)).toBe(runtime.entry)
  })

  test("runs under sh with the arguments it was given", () => {
    const paths = sandbox()
    installOmp({ paths, runtime: { ...runtime, node: "/bin/echo", entry: "entry" }, skill: upstreamSkill, mcp: false })
    const result = Bun.spawnSync([paths.launcher, "status", "--json", "a b"])
    expect(result.stdout.toString()).toBe("entry status --json a b\n")
  })

  test("refuses a file it didn't write, and writes nothing", () => {
    const paths = sandbox()
    fs.mkdirSync(path.dirname(paths.launcher), { recursive: true })
    fs.writeFileSync(paths.launcher, "#!/bin/sh\necho someone else's browse\n")
    expect(() => install(paths, true)).toThrow(OmpError)
    expect(fs.readFileSync(paths.launcher, "utf8")).toBe("#!/bin/sh\necho someone else's browse\n")
    expect(fs.existsSync(paths.skill)).toBe(false)
    expect(fs.existsSync(paths.mcpConfig)).toBe(false)
    expect(fs.existsSync(paths.manifest)).toBe(false)
  })

  test("refuses a symlink", () => {
    const paths = sandbox()
    fs.mkdirSync(path.dirname(paths.launcher), { recursive: true })
    fs.symlinkSync("/bin/sh", paths.launcher)
    expect(() => install(paths)).toThrow(/wasn't written by install/)
  })

  test("rewrites its own launcher when the runtime moves", () => {
    const paths = sandbox()
    install(paths)
    const lines = installOmp({ paths, runtime: { ...runtime, entry: "/new/cli.mjs" }, skill: upstreamSkill, mcp: false })
    expect(lines[0]).toContain("updated")
    expect(launcherTarget(paths.launcher)).toBe("/new/cli.mjs")
  })
})

describe("skill", () => {
  const skill = ompSkill(upstreamSkill)

  test("keeps the frontmatter first and marks the file as install's", () => {
    expect(skill.startsWith("---\nname: browse\n")).toBe(true)
    expect(skill).toMatch(/\n---\n<!-- Written by `opencode-browser install --client omp`/)
  })

  test("tells omp to run browse through bash, after the title", () => {
    expect(skill).toMatch(/\n# browse \(OpenCode Browser\)\n\n> \*\*In omp:\*\* run browse as shell commands through bash/)
  })

  test("renames the CLI and leaves paths and package names alone", () => {
    expect(skill).toContain("\nbrowse execute 'return { url: page.url(), title: await page.title() }'\n")
    expect(skill).toContain('from "opencode-browser-cli"')
    expect(skill).toContain("~/.local/share/opencode-browser/relays/<port>/lifecycle.jsonl")
    const body = skill.slice(skill.indexOf("-->"))
    expect(body).not.toMatch(/opencode-browser (?:execute|session|status|doctor|install|pair|relay|settings|network|secrets|recording|journal|tabs)\b/)
    expect(skill).toContain("(`browse update`)")
    expect(skill).toContain("restarts omp")
  })

  test("names only commands and flags the CLI has", () => {
    const cli = fs.readFileSync(path.join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    const main = fs.readFileSync(path.join(import.meta.dir, "..", "src", "main.ts"), "utf8")
    const commands = skill.split("\n").filter((line) => /^browse [a-z]/.test(line))
    expect(commands.length).toBeGreaterThan(20)
    for (const line of commands) {
      const words = line.replace(/\s+#.*$/, "").split(/\s+/)
      const command = words[1]!
      expect(cli.includes(`"${command}"`) || main.includes(`"${command}"`)).toBe(true)
      for (const flag of words.filter((word) => word.startsWith("--")).map((word) => word.slice(2).split("=")[0]!))
        expect({ line, flag, defined: cli.includes(`"${flag}"`) }).toEqual({ line, flag, defined: true })
    }
  })

  test("is written, refused over a foreign file, and its folder kept when the user has other files in it", () => {
    const paths = sandbox()
    install(paths)
    expect(fs.readFileSync(paths.skill, "utf8")).toBe(skill)
    fs.writeFileSync(path.join(path.dirname(paths.skill), "notes.md"), "mine\n")
    uninstallOmp(paths)
    expect(fs.existsSync(paths.skill)).toBe(false)
    expect(fs.readdirSync(path.dirname(paths.skill))).toEqual(["notes.md"])

    fs.writeFileSync(paths.skill, "---\nname: browse\n---\nmy own skill\n")
    expect(() => install(paths)).toThrow(/SKILL\.md exists and wasn't written by install/)
  })
})

describe("omp's mcp.json", () => {
  // Tabs, an extra top-level key and a server with keys omp doesn't know, all of which must survive.
  const original = `{\n\t"$schema": "https://example.com/mcp.json",\n\t"mcpServers": {\n\t\t"executor": { "type": "http", "url": "http://127.0.0.1:4100/mcp", "headers": { "x": "!cat ~/.token" } },\n\t\t"other": {\n\t\t\t"command": "other-mcp",\n\t\t\t"args": []\n\t\t}\n\t},\n\t"disabledServers": ["other"]\n}\n`

  function withConfig(text = original) {
    const paths = sandbox()
    fs.mkdirSync(path.dirname(paths.mcpConfig), { recursive: true })
    fs.writeFileSync(paths.mcpConfig, text)
    return paths
  }

  test("is left alone without --mcp", () => {
    const paths = withConfig()
    install(paths)
    expect(fs.readFileSync(paths.mcpConfig, "utf8")).toBe(original)
  })

  test("gets a browse stdio server with --mcp, and every other byte stays", () => {
    const paths = withConfig()
    const lines = install(paths, true)
    expect(lines).toContain(`✓ omp MCP server "browse" added to ${paths.mcpConfig} (restart omp to load it)`)
    const config = readJson(paths.mcpConfig)
    expect(config.mcpServers.browse).toEqual({ command: runtime.node, args: [runtime.entry, "mcp"], env: { OPENCODE_BROWSER_RUNTIME: runtime.fingerprint } })
    expect(Object.keys(config.mcpServers)).toEqual(["executor", "other", "browse"])
    expect(fs.readFileSync(paths.mcpConfig, "utf8")).toContain('\t\t"browse": {\n\t\t\t"command"')
    uninstallOmp(paths)
    expect(fs.readFileSync(paths.mcpConfig, "utf8")).toBe(original)
  })

  test("is created when omp has none yet", () => {
    const paths = sandbox()
    install(paths, true)
    expect(readJson(paths.mcpConfig)).toEqual({ mcpServers: { browse: { command: runtime.node, args: [runtime.entry, "mcp"], env: { OPENCODE_BROWSER_RUNTIME: runtime.fingerprint } } } })
  })

  test("refresh keeps the user's own settings on the server, and later installs keep it current without --mcp", () => {
    const paths = withConfig()
    install(paths, true)
    const config = readJson(paths.mcpConfig)
    config.mcpServers.browse.timeout = 60_000
    config.mcpServers.browse.env.OPENCODE_BROWSER_PORT = "19989"
    fs.writeFileSync(paths.mcpConfig, JSON.stringify(config, null, "\t") + "\n")
    expect(install(paths, true)).toContain('✓ omp MCP server "browse" is up to date')
    installOmp({ paths, runtime: { ...runtime, fingerprint: "fedcba9876543210" }, skill: upstreamSkill, mcp: false })
    expect(readJson(paths.mcpConfig).mcpServers.browse).toEqual({
      command: runtime.node,
      args: [runtime.entry, "mcp"],
      env: { OPENCODE_BROWSER_RUNTIME: "fedcba9876543210", OPENCODE_BROWSER_PORT: "19989" },
      timeout: 60_000,
    })
  })

  test("adopts a hand-added browse server that runs a browse bundle", () => {
    const paths = withConfig(`{\n  "mcpServers": {\n    "browse": { "command": "node", "args": ["/old/browse/cli/dist/cli.mjs", "mcp"] }\n  }\n}\n`)
    install(paths, true)
    expect(readJson(paths.mcpConfig).mcpServers.browse.args).toEqual([runtime.entry, "mcp"])
  })

  test("refuses another program's browse server, and writes nothing", () => {
    const foreign = `{\n  "mcpServers": {\n    "browse": { "command": "some-other-browse" }\n  }\n}\n`
    const paths = withConfig(foreign)
    expect(() => install(paths, true)).toThrow(/already has a "browse" MCP server/)
    expect(fs.readFileSync(paths.mcpConfig, "utf8")).toBe(foreign)
    expect(fs.existsSync(paths.launcher)).toBe(false)
  })

  test("refuses a file that isn't JSON", () => {
    const paths = withConfig("{ // comments aren't JSON\n}\n")
    expect(() => install(paths, true)).toThrow(/isn't a JSON object/)
  })

  test("uninstall leaves a browse server install didn't write", () => {
    const handAdded = `{\n  "mcpServers": {\n    "browse": { "command": "node", "args": ["/old/browse/cli/dist/cli.mjs", "mcp"] }\n  }\n}\n`
    const paths = withConfig(handAdded)
    install(paths)
    uninstallOmp(paths)
    expect(fs.readFileSync(paths.mcpConfig, "utf8")).toBe(handAdded)
  })
})

describe("uninstall", () => {
  test("removes everything install wrote, from where it recorded writing it", () => {
    const paths = sandbox()
    fs.mkdirSync(path.dirname(paths.mcpConfig), { recursive: true })
    fs.writeFileSync(paths.mcpConfig, `{\n  "mcpServers": {}\n}\n`)
    install(paths, true)
    expect(readJson(paths.manifest)).toEqual({ launcher: paths.launcher, skill: paths.skill, mcpConfig: paths.mcpConfig })
    // Without the flags, the paths come from the record.
    const recorded = ompPaths(path.dirname(paths.manifest), [], {}, "/nonexistent-home")
    expect(recorded).toEqual({ launcher: paths.launcher, skill: paths.skill, mcpConfig: paths.mcpConfig, manifest: paths.manifest })
    const lines = uninstallOmp(recorded)
    expect(lines).toHaveLength(3)
    expect(fs.existsSync(paths.launcher)).toBe(false)
    expect(fs.existsSync(path.dirname(paths.skill))).toBe(false)
    expect(fs.existsSync(paths.manifest)).toBe(false)
    // jsonc-parser leaves the emptied object on two lines; with other servers the file comes back byte for byte.
    expect(readJson(paths.mcpConfig)).toEqual({ mcpServers: {} })
  })

  test("leaves files it didn't write", () => {
    const paths = sandbox()
    fs.mkdirSync(path.dirname(paths.launcher), { recursive: true })
    fs.writeFileSync(paths.launcher, "#!/bin/sh\n")
    expect(uninstallOmp(paths)).toEqual([])
    expect(fs.readFileSync(paths.launcher, "utf8")).toBe("#!/bin/sh\n")
  })
})

describe("status", () => {
  test("says nothing when omp is neither installed nor set up", () => {
    expect(ompStatus(sandbox(), false)).toEqual([])
  })

  test("reports the launcher, skill and MCP server", () => {
    const paths = sandbox()
    expect(ompStatus(paths, true)).toEqual(["omp:       not set up. Run install with --client omp."])
    install(paths)
    expect(ompStatus(paths, true)).toEqual([
      `omp:       launcher ${paths.launcher} → ${runtime.entry} (missing; run install again)`,
      `           skill ${paths.skill}`,
      "           MCP server not configured (install --client omp --mcp adds it)",
    ])
  })
})

describe("clients", () => {
  test("--client takes one or both, in either form", () => {
    expect(clientFlag(["--client", "omp"])).toEqual(["omp"])
    expect(clientFlag(["--client=omp,opencode"])).toEqual(["opencode", "omp"])
    expect(clientFlag([])).toBeUndefined()
    expect(() => clientFlag(["--client", "claude"])).toThrow(OmpError)
    expect(() => clientFlag(["--client", ""])).toThrow(OmpError)
  })

  test("without --client: the recorded clients, else opencode, else omp when only omp is installed", () => {
    expect(resolveClients({ flag: ["omp"], recorded: ["opencode"], opencode: true, ompInstalled: true })).toEqual(["omp"])
    expect(resolveClients({ flag: undefined, recorded: ["opencode", "omp"], opencode: true, ompInstalled: true })).toEqual(["opencode", "omp"])
    expect(resolveClients({ flag: undefined, recorded: undefined, opencode: true, ompInstalled: true })).toEqual(["opencode"])
    expect(resolveClients({ flag: undefined, recorded: undefined, opencode: false, ompInstalled: false })).toEqual(["opencode"])
    expect(resolveClients({ flag: undefined, recorded: "garbage", opencode: false, ompInstalled: true })).toEqual(["omp"])
  })

  test("paths: flags, then environment variables, then defaults", () => {
    const env = { OPENCODE_BROWSER_BIN_DIR: "/env/bin", PI_CODING_AGENT_DIR: "/pi/agent" }
    expect(ompPaths("/nonexistent-data", ["--skills-dir", "/flag/skills"], env, "/home/u")).toEqual({
      launcher: "/env/bin/browse",
      skill: "/flag/skills/browse/SKILL.md",
      mcpConfig: "/pi/agent/mcp.json",
      manifest: "/nonexistent-data/omp.json",
    })
    expect(ompPaths("/nonexistent-data", [], {}, "/home/u")).toEqual({
      launcher: "/home/u/.local/bin/browse",
      skill: "/home/u/.agents/skills/browse/SKILL.md",
      mcpConfig: "/home/u/.omp/agent/mcp.json",
      manifest: "/nonexistent-data/omp.json",
    })
  })
})
