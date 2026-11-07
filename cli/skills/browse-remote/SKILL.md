---
name: browse-remote
description: Drive Safzan's Mac browser profiles from ampere with `browse` (OpenCode Browser) through one ssh tunnel to the Mac's relay (127.0.0.1:19988 on both hosts). Use when a task on ampere needs a logged-in browser session through browse, when `browse` on ampere says the relay is unreachable or "Automatic relay startup is disabled", or fails with HTTP 401 "Missing or invalid OpenCode Browser relay token" or a relay build mismatch.
---

# browse from ampere

The Mac runs one browse relay on `127.0.0.1:19988`; every Chrome profile is a browser paired with it under its own
name (`browse status` on the Mac lists them). The relay's HTTP API and CDP answer on 127.0.0.1 only, so ampere reaches
it through an ssh tunnel on the same port, and runs the same CLI build locally as `browse`. The `browse` skill owns
the driving API (sessions, execute, adoption, handoffs, the browser table); this skill only gets a working connection.

## Quick start

```bash
~/.agents/skills/browse-remote/scripts/mac-relays.sh up       # tunnel 127.0.0.1:19988 → the Mac's 19988
~/.agents/skills/browse-remote/scripts/mac-relays.sh status   # tunnel process, then the relay's /extension/status

browse find                                                   # every browser: connection, attached tabs
browse find figma.com                                         # which browser has it, and the command to run next
browse session adopt --tab-id 123 --session figma
browse --profile work execute --session figma2 'return page.url()'
browse session delete figma

~/.agents/skills/browse-remote/scripts/mac-relays.sh down
```

`--profile <name>` picks the paired browser by its "Name for agents" (`work`, `insideiim`, `safzan`, `patty`,
`ananya`, `lilcheaty`, `an`), exactly as on the Mac. `find` here shows live tabs but no visited sites, since the
session journals stay on the Mac.

## What `browse` is here

`~/.local/bin/browse` first runs `mac-relays.sh check`, which refuses (and sends no token) unless 127.0.0.1:19988 is
the ssh tunnel `up` started, then runs `~/apps/browse/cli/dist/cli.mjs` with ampere's node and always sets:

- `OPENCODE_BROWSER_AUTOSTART=false`: with the tunnel down, a call fails ("Automatic relay startup is disabled")
  instead of starting a local relay that holds 19988 and later breaks the tunnel.
- `OPENCODE_BROWSER_HOME=~/.opencode-browser-mac`: the Mac's relay token (mode 0600), apart from any local relay's
  data. Every call except `/version` needs that token; without it the relay answers 401.
- `OPENCODE_BROWSER_PORT=19988`.

Ubuntu ships `/usr/bin/browse` as a link to `xdg-open`. A non-login shell (`ssh ampere 'browse …'`) has no
`~/.local/bin` on PATH and runs that instead, so call `~/.local/bin/browse` by full path there.

Execute code, `files.write()`, network captures and `secrets run` all run on the Mac relay, so files they write are on
the Mac. Never run `browse install`, `update`, `pair` or `relay` commands here; those belong on the Mac (`start-mac`
and `stop-mac` below run the relay ones there). The launcher refuses `mcp` and `serve`: a long-lived server would keep
sending the token after the tunnel closed, so agents here use the CLI.

## Both sides run the same build

`mac-relays.sh sync` copies the Mac's installed CLI (the one its `~/.local/bin/browse` runs: `dist/`,
`package.json`, `bun.lock`, this skill) into a new `~/apps/browse/releases/<stamp>`, runs `bun install --production`
when the dependencies changed, then points the `~/apps/browse/cli` symlink at it; it also copies the relay token from
the Mac's `~/.local/share/browse/relay-token` and rewrites the launcher and this skill. It installs the Mac's
`~/.agents/skills/browse` here too, with a note on this host; a browse skill here that `sync` didn't write is left
alone. One sync runs at a time (`~/apps/browse/.sync.lock`). Run it after every rebuild or install on the Mac.

When this script changed, the first `sync` runs the old copy. Bootstrap from the Mac's checkout instead, as on a new
host (an install from the per-profile layout needs this once: its script reads the token from the old data folder):

```bash
ssh mac 'cat ~/Development/projects/browse/cli/skills/browse-remote/scripts/mac-relays.sh' > /tmp/mac-relays.sh
bash /tmp/mac-relays.sh sync && rm /tmp/mac-relays.sh
```

## The Mac relay is not running

`status` showing HTTP 000 or a connection error means nothing listens on the Mac's 19988. Start it there:

```bash
~/.agents/skills/browse-remote/scripts/mac-relays.sh start-mac   # browse relay restart, on the Mac
~/.agents/skills/browse-remote/scripts/mac-relays.sh stop-mac    # browse relay stop on the Mac (drained; tabs stay)
```

A browser shows as disconnected until its Chrome profile is open. Ask Safzan to open it; do not drive another profile
in its place.

## Failure modes

- **HTTP 401**: `~/.opencode-browser-mac/relay-token` is missing or stale (the Mac's was regenerated). Run `sync`.
- **`isn't the Mac tunnel`** (from the launcher), **`Automatic relay startup is disabled`** or `ECONNREFUSED`: the
  tunnel is down. Run `up`.
- **ssh tunnel dies at once**: ampere multiplexes `mac`, so `up` passes `ControlPath=none` and binds `127.0.0.1`.
  Cancel a stray multiplexed forward with `ssh -O cancel -L 127.0.0.1:19988:127.0.0.1:19988 mac`.
- **`No current window`**: Chrome on the Mac has no window. Ask Safzan to open one.
- **`status` starts with `Setup: not installed`**: expected here, nothing is installed on ampere but the CLI copy.
  Don't run `install`.

Log and pid: `~/.opencode-browser-mac/mac-relays/` (`ssh.log`, `ssh.pid`).
