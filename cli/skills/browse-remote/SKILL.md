---
name: browse-remote
description: Drive Safzan's Mac browser profiles from ampere with `browse` (OpenCode Browser) through tunnelled relays (Mac profile ports 19960-19966, reached on ampere at port + 10000). Use when a task on ampere needs a logged-in browser session through browse, when `browse` on ampere says the relay is unreachable or "Automatic relay startup is disabled", or fails with "Invalid Host header port", HTTP 401 "Missing or invalid OpenCode Browser relay token", or a relay build mismatch.
---

# browse from ampere

The Mac runs one browse relay per browser profile on `127.0.0.1`, ports 19960-19966 (`browse profiles list` on the
Mac maps them to profiles). Ampere reaches them through ssh tunnels and a Host-rewriting proxy, and runs the same CLI
build locally as `browse`. The `browse` skill owns the driving API (sessions, execute, adoption, handoffs); this
skill only gets a working connection.

## Quick start

```bash
~/.agents/skills/browse-remote/scripts/mac-relays.sh up       # tunnels every profile in the Mac's profiles.json
~/.agents/skills/browse-remote/scripts/mac-relays.sh status   # processes, then each relay's /extension/status

browse find                                                   # every profile: relay, extension, attached tabs
browse find figma.com                                         # which profile has it, and the command to run next
browse --profile work session adopt --tab-id 123 --session figma
browse --profile work execute --session figma 'return page.url()'
browse --profile work session delete figma

~/.agents/skills/browse-remote/scripts/mac-relays.sh down
```

`up` copies the Mac's profiles into `~/.opencode-browser-mac/profiles.json` with the ampere ports, so
`browse --profile <name>` (or an email from the profile's label), `OPENCODE_BROWSER_PROFILE=<name>` and `browse find`
work as on the Mac; `OPENCODE_BROWSER_PORT=<Mac port + 10000>` does too. A profile added on the Mac appears after the
next `up`. `profiles list` here marks every extension folder missing: the folders live on the Mac, ignore that line.
`find` here shows live tabs but no visited sites, since the session journals stay on the Mac.

Each profile keeps its Mac port + 10000. The profile table is in the `browse` skill, which `sync` installs here from
the Mac:

| Mac port | Ampere port (proxy) | Tunnel |
|---|---|---|
| 19960-19966 (profiles) | 29960-29966 | 39960-39966 |
| 19988 (plain `dist/`, `up 19988`) | 29988 | 39988 |

Never tunnel or start 19989-19995 with this skill: those are browser-control's relays, and the script refuses them.
Ampere's 19990 is Rakhi's proxy.

## What `browse` is here

`~/.local/bin/browse` runs `~/apps/browse/cli/dist/cli.mjs` with ampere's node and always sets:

- `OPENCODE_BROWSER_AUTOSTART=false`: with the tunnels down, a call fails ("Automatic relay startup is disabled")
  instead of starting a local relay that holds the port and later breaks the tunnel.
- `OPENCODE_BROWSER_HOME=~/.opencode-browser-mac`: the Mac's relay token (mode 0600) and the shifted profiles, apart
  from any local relay's data. Every call except `/version` needs that token; without it the relay answers 401.

Ubuntu ships `/usr/bin/browse` as a link to `xdg-open`. A non-login shell (`ssh ampere 'browse …'`) has no
`~/.local/bin` on PATH and runs that instead, so call `~/.local/bin/browse` by full path there.

Execute code, `files.write()`, network captures and `secrets run` all run on the Mac relay, so files they write are on
the Mac. Never run `browse install`, `update`, or `profiles add|remove|sync` here; those belong on the Mac. Don't use
the `webSocketDebuggerUrl` from `/json/version` on ampere: it names the Mac port and carries the token, so a client
that follows it sends the token to whatever listens on that port here.

## Both sides run the same build

`mac-relays.sh sync` copies the Mac's installed CLI (the one its `~/.local/bin/browse` runs: `dist/`,
`package.json`, `bun.lock`, this skill) into a new `~/apps/browse/releases/<stamp>`, runs `bun install --production`
when the dependencies changed, then points the `~/apps/browse/cli` symlink at it; it also copies the relay token and
rewrites the launcher and this skill. It installs the Mac's `~/.agents/skills/browse` (the driving API) as
`~/.agents/skills/browse` here too, with a note on this host; a browse skill here that `sync` didn't write is left
alone. One sync runs at a time (`~/apps/browse/.sync.lock`). Run it after every rebuild or install on the Mac. A
different build on the same client protocol is only a warning; a protocol change fails until you sync. If
`~/apps/browse/cli` is ever missing after an interrupted first sync of an old plain-folder install, put it back with
`mv ~/apps/browse/releases/00000000-legacy-* ~/apps/browse/cli`.

First time on a new host (the skill isn't there yet):

```bash
ssh mac 'cat ~/Development/projects/browse/cli/skills/browse-remote/scripts/mac-relays.sh' > /tmp/mac-relays.sh
bash /tmp/mac-relays.sh sync && rm /tmp/mac-relays.sh
```

## A Mac relay is not running

`status` showing `HTTP 502 ... unreachable through tunnel` means nothing listens on that Mac port. Relays for idle
profiles stay down, and `status` does not start one. Start it on the Mac:

```bash
~/.agents/skills/browse-remote/scripts/mac-relays.sh start-mac 19961   # OPENCODE_BROWSER_PORT=19961 browse relay restart, on the Mac
~/.agents/skills/browse-remote/scripts/mac-relays.sh stop-mac 19961    # browse relay stop on the Mac (drained; tabs stay)
```

It then reports `"connected":false` until that browser profile is open with its extension copy loaded. Ask Safzan to
open the profile; do not drive the others in his place.

## Failure modes

- **`Invalid Host header port`**: the CLI hit a tunnel port (3996x) instead of the proxy port (2996x).
- **HTTP 401**: `~/.opencode-browser-mac/relay-token` is missing or stale (the Mac's was regenerated). Run `sync`.
- **`Automatic relay startup is disabled`** or `ECONNREFUSED`: the tunnels are down. Run `up`.
- **ssh tunnel dies at once**: ampere multiplexes `mac`, so `up` passes `ControlPath=none` and binds `127.0.0.1`.
  Cancel a stray multiplexed forward with `ssh -O cancel -L <spec> mac`, using the spec it was created with.
- **`No current window`**: Chrome on the Mac has no window. Ask Safzan to open one.
- **`status` starts with `Setup: not installed` and `omp: not set up`**: expected here, nothing is installed on
  ampere but the CLI copy. Don't run `install`. `status --json` prints only the JSON.

Logs and pids: `~/.opencode-browser-mac/mac-relays/` (`ssh.log`, `proxy.log`).
