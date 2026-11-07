// `--profile <browser>`: which paired browser (one Chrome profile with browse) a command's new sessions and settings
// use. It names the browser's id, the slug of the name set under "Name for agents" on its Options page, or that name
// in full; the relay resolves it (relay/browser-links.ts byId). main.ts strips the flag from argv before any command
// parses it and keeps the choice in OPENCODE_BROWSER_PROFILE, which callers can also set themselves.

export const browserProfileVariable = "OPENCODE_BROWSER_PROFILE"

/**
 * `args` without `--profile <name>` / `--profile=<name>`, and the name. Arguments after `--` are left alone (they
 * belong to `secrets run`'s command).
 */
export function takeProfileFlag(args: readonly string[]): { readonly args: string[]; readonly profile?: string } {
  const rest: string[] = []
  let profile: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      rest.push(...args.slice(index))
      break
    }
    if (arg === "--profile") {
      profile = args[++index]
      if (profile === undefined || profile.startsWith("-")) throw new Error("--profile needs a browser name (see `status`).")
    } else if (arg.startsWith("--profile=")) profile = arg.slice("--profile=".length)
    else rest.push(arg)
  }
  const name = profile?.trim()
  if (profile !== undefined && !name) throw new Error("--profile needs a browser name (see `status`).")
  return name ? { args: rest, profile: name } : { args: rest }
}

/** main.ts's hook: moves `--profile` from argv into OPENCODE_BROWSER_PROFILE before any command reads either. */
export function applyProfileSelection(argv = process.argv, env = process.env): void {
  try {
    const selection = takeProfileFlag(argv.slice(2))
    argv.splice(2, argv.length - 2, ...selection.args)
    if (selection.profile) env[browserProfileVariable] = selection.profile
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(1)
  }
}

/** The browser this process was asked to use, if any. */
export function selectedBrowser(env = process.env): string | undefined {
  return env[browserProfileVariable]?.trim() || undefined
}
