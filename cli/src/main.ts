#!/usr/bin/env node
// opencode-browser: one command for OpenCode Browser.
//   Setup (setup.ts): install, extension, pair, uninstall, profiles (profiles.ts). Updating (update.ts): update.
//   Driving the browser (cli.ts): serve, relay, execute, session, network, secrets, recording, journal,
//   doctor, skill, mcp, status. The relay is the local server agents use; the extension connects to it.
// `opencode-browser mcp` runs the MCP server over stdio (as does the bundle invoked as `opencode-browser-mcp`).
import path from "node:path"
import { applyProfileSelection } from "./profiles.ts"

// `--profile <name>` / OPENCODE_BROWSER_PROFILE pick a profile's relay port, before any command reads it.
applyProfileSelection()
const setupCommands = new Set(["install", "uninstall", "extension", "pair", "profiles"])
const command = process.argv[2]
const invokedAs = path.basename(process.argv[1] ?? "")

if (invokedAs === "opencode-browser-mcp") {
  const { NodeRuntime } = await import("@effect/platform-node")
  const { runMcpServer } = await import("./mcp.ts")
  runMcpServer.pipe(NodeRuntime.runMain)
} else if (command === "update") {
  const { runUpdateCommand } = await import("./update.ts")
  await runUpdateCommand(process.argv.slice(3))
} else if (command === "find") {
  const { runFindCommand } = await import("./find.ts")
  await runFindCommand(process.argv.slice(3))
} else if (command && setupCommands.has(command)) {
  const { runSetup } = await import("./setup.ts")
  await runSetup(command, process.argv.slice(3))
} else {
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`SETUP
  install [--opencode <path>]    Install OpenCode Browser: add the browse MCP server to opencode, pair
                                 the extension, and check which browsers have it (when none does, open
                                 the extensions page, show the folder to load unpacked and wait for it)
    --no-open                    Print the steps without opening anything or copying the path
    --no-wait                    Don't wait for the extension to connect
    --client <opencode,omp>      Which agents to set up (default: the last install's, else opencode, or omp
                                 when only omp is installed). omp gets a \`browse\` launcher on PATH and the
                                 browse skill; --bin-dir, --skills-dir and --omp-dir move them
    --mcp                        With omp: also add the browse MCP server to omp's mcp.json
  extension                      Show the unpacked extension folder (for "Load unpacked")
  pair                           Print the pairing code the Chrome Web Store extension asks for
  update [--check]               Update a git clone install: pull the newer commits (fast-forward only) and
                                 run setup again; --check only says whether there's an update
  uninstall [--yes]              Remove everything install set up (--yes skips confirming that stored
                                 secret profiles are deleted); --client omp removes only omp's files

PROFILES (one relay and one extension copy per browser profile)
  profiles add <name>            Copy the extension for a browser profile, pinned to its own relay port
    --port <port>                The relay port (default: the next free one in 19960-19966)
    --label <text>               A note shown by list, e.g. which browser profile loads it
  profiles list [--json]         Each profile's port, folder, and whether its relay and extension are up
  profiles remove <name>         Forget a profile and delete its extension copy
  profiles sync [--no-reload]    Copy the current build and pairing code into every profile (after a
                                 rebuild) and reload the connected extensions
  --profile <name>               On any command: use that profile's relay (OPENCODE_BROWSER_PROFILE works
                                 too; without either, OPENCODE_BROWSER_PORT or 19988). An email or browser
                                 profile folder from exactly one profile's label works as the name
  find [query] [--json]          Every profile's relay, extension and attached tabs; with a query, the
                                 matching tabs, the profiles that visited it before, and the command to run
                                 next. Starts no relay

`)
  }
  if (command === "status") {
    // `--client` selects which setup to report; the relay status that follows doesn't take it.
    const client = process.argv.findIndex((arg, index) => index > 2 && (arg === "--client" || arg.startsWith("--client=")))
    const selector = client === -1 ? [] : process.argv.splice(client, process.argv[client] === "--client" ? 2 : 1)
    // `status --json` prints only the relay's JSON, so callers can parse it whole.
    const { printSetupStatus } = await import("./setup.ts")
    if (!process.argv.includes("--json")) printSetupStatus(selector)
  }
  await import("./cli.ts")
}
