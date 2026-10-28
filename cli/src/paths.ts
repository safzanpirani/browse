// Where OpenCode Browser keeps its files: the installed runtime, the relay's log, session catalogs and
// journals, and captured secrets. One root, so `uninstall` can remove it and logs are easy to find.
//   macOS/Linux: $XDG_DATA_HOME/opencode-browser, else ~/.local/share/opencode-browser
//   Windows:     %LOCALAPPDATA%\opencode-browser
// OPENCODE_BROWSER_HOME overrides it (isolated test relays).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function dataRoot(home = os.homedir()): string {
  const override = process.env.OPENCODE_BROWSER_HOME
  if (override) return override
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "opencode-browser")
  const xdg = home === os.homedir() ? process.env.XDG_DATA_HOME : undefined
  return path.join(xdg ?? path.join(home, ".local", "share"), "opencode-browser")
}

/** This package's root: cli/ in a checkout (src/paths.ts, or the dist/cli.mjs bundle), else the installed package. */
const packageRoot = () => path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Running from a source checkout (the sources are next to the bundle), not the published npm package. */
export function fromCheckout(): boolean {
  return fs.existsSync(path.join(packageRoot(), "src", "main.ts"))
}

/** The git clone this runs from (the folder above cli/), or undefined for the published package. */
export function checkoutRoot(): string | undefined {
  return fromCheckout() ? path.dirname(packageRoot()) : undefined
}

const quoted = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value))

/**
 * How to tell the user to run `opencode-browser <args>`: as the launcher that ran this (OPENCODE_BROWSER_COMMAND, which
 * omp's `browse` launcher sets), else through npx from the published package, else with this checkout's bundle (where
 * nothing is on PATH and the package may not be published). A selected profile is kept, so a printed command reaches
 * the same relay.
 */
export function cliCommand(args: string): string {
  const profile = process.env.OPENCODE_BROWSER_PROFILE
  const full = profile && !/(?:^|\s)--profile[\s=]/.test(args) ? `--profile ${quoted(profile)} ${args}` : args
  if (process.env.OPENCODE_BROWSER_COMMAND) return `${process.env.OPENCODE_BROWSER_COMMAND} ${full}`
  return fromCheckout()
    ? `node ${quoted(path.join(packageRoot(), "dist", "cli.mjs"))} ${full}`
    : `npx opencode-browser-cli ${full}`
}

/**
 * Whether the Chrome Web Store listing is live. Until it is, install guides loading the unpacked build instead of
 * opening the listing; set it to true when the listing is published to restore the store flow.
 */
export const STORE_LISTED = false

/** How to tell the user to install (or update) OpenCode Browser. */
export function installCommand(): string {
  return fromCheckout() ? `cd ${quoted(path.dirname(packageRoot()))} && bun run setup` : "npx opencode-browser-cli install"
}
