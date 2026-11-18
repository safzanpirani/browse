---
name: browse-remote
description: Drive Safzan's Mac browser profiles from ampere with `browse` (OpenCode Browse, Rust build of the omp fork) through one ssh tunnel to the Mac's relay (127.0.0.1:19988 on both hosts). Use when a task on ampere needs a logged-in browser through browse, when `browse` on ampere says the relay is unreachable or "automatic relay startup is disabled", or fails with HTTP 401 or a version mismatch after `sync`.
---

# browse from ampere

The Mac runs one browse relay on `127.0.0.1:19988`; every browser profile is paired with it under its own name
(`browse status` on the Mac lists them). The relay's HTTP API answers on 127.0.0.1 only, so ampere reaches it through
an ssh tunnel on the same port and runs a Linux build of the same browse locally. The `browse` skill owns the driving
API (tabs, `--profile`, execute, handoffs, the browser table); this skill only gets a working connection.

## Quick start

The tunnel normally runs as the systemd user service `browse-mac-tunnel` (`mac-relays.sh service install`; needs
`socat`). A socat listener holds 127.0.0.1:19988 for the whole run and an ssh client behind it forwards to the Mac,
reconnecting 5 s after a drop, so no other program can take the port in the gap; while ssh is down the launcher
refuses to run. The service also comes back after a reboot. Check it before driving:

```bash
~/.agents/skills/browse-remote/scripts/mac-relays.sh status   # tunnel process, then the relay's /extension/status
~/.agents/skills/browse-remote/scripts/mac-relays.sh up       # (re)start the tunnel: restarts the service if installed

browse find                                                   # every browser: connection, agent and lent tabs
browse find figma.com                                         # which browser has it, and the command to run next
browse --profile work navigate https://example.com            # opens a tab in `work`, prints its "tab"
browse snapshot --tab 12
browse tabs close --tab 12

~/.agents/skills/browse-remote/scripts/mac-relays.sh down     # stops it until the next `up` or reboot
```

`--profile <name>` picks the paired browser by its "Name for agents" (`work`, `insideiim`, `safzan`, `safzan-chrome`,
`patty`, `ananya`, `lilcheaty`, `an`), exactly as on the Mac. Tab ids are the relay's, so a tab opened from either
host is used from the other with the same `--tab`.

## What `browse` is here

`~/.local/bin/browse` first runs `mac-relays.sh check`, which refuses (and sends no token) unless 127.0.0.1:19988 is
the ssh tunnel `up` started, then runs `~/apps/browse/cli/browse` (a static Linux build) and always sets:

- `OPENCODE_BROWSER_AUTOSTART=false`: with the tunnel down, a call fails instead of starting a local relay that holds
  19988 and later breaks the tunnel.
- `OPENCODE_BROWSER_HOME=~/.opencode-browser-mac`: the Mac's relay token (mode 0600), apart from any local relay's
  data. Every call except `/version` needs that token; without it the relay answers 401.
- `OPENCODE_BROWSER_PORT=19988`.

Ubuntu ships `/usr/bin/browse` as a link to `xdg-open`. A non-login shell (`ssh ampere 'browse …'`) has no
`~/.local/bin` on PATH and runs that instead, so call `~/.local/bin/browse` by full path there.

Execute code, `files.write()`, network captures, screenshots the relay saves and recordings all run on the Mac relay,
so the files they write are on the Mac. Never run `browse install`, `update`, `pair`, `restart` or `stop` here; those
belong on the Mac (`start-mac` and `stop-mac` below run the relay ones there). The launcher refuses `mcp` and `serve`:
a long-lived server would keep sending the token after the tunnel closed, so agents here use the CLI.

## Both sides run the same build

`mac-relays.sh sync` reads the binary the Mac's `~/.local/bin/browse` runs (`<checkout>/rust/target/release/browse`),
copies the Mac's Linux build for this host (`<checkout>/rust/target/aarch64-unknown-linux-musl/release/browse` on
ampere; `BROWSE_MAC_LINUX_BINARY` overrides) and this skill into a new `~/apps/browse/releases/<stamp>`, checks that it
answers the same `--version` as the Mac's, then points the `~/apps/browse/cli` symlink at it. It also copies the relay
token from the Mac's `~/.local/share/browse/relay-token`, rewrites the launcher and this skill, and installs the Mac's
`~/.agents/skills/browse` here with a note on this host (a browse skill here that `sync` didn't write is left alone).
One sync runs at a time (`~/apps/browse/.sync.lock`). Run it after every rebuild or install on the Mac.

Build the Linux binary on the Mac first (offbox builds it on server-pc and copies it back; `-f` takes the remote path
from the checkout root):

```bash
cd ~/Development/projects/browse/rust && offbox run \
  -f rust/target/aarch64-unknown-linux-musl/release/browse:$PWD/target/aarch64-unknown-linux-musl/release/browse \
  -- mbx zigbuild --release --locked -p browse --target aarch64-unknown-linux-musl
```

When this script changed, the first `sync` runs the old copy. Bootstrap from the Mac's checkout instead, as on a new
host:

```bash
ssh mac 'cat ~/Development/projects/browse/skills/browse-remote/scripts/mac-relays.sh' > /tmp/mac-relays.sh
bash /tmp/mac-relays.sh sync && rm /tmp/mac-relays.sh
```

## The Mac relay is not running

`status` showing HTTP 000 or a connection error means nothing listens on the Mac's 19988. The Mac starts its relay at
login (LaunchAgent `dev.safzan.browse-relay`, which runs `browse restart` once) and every browse command there starts
it on demand, so this happens only when it was stopped or crashed since. Start it there:

```bash
~/.agents/skills/browse-remote/scripts/mac-relays.sh start-mac   # browse restart, on the Mac
~/.agents/skills/browse-remote/scripts/mac-relays.sh stop-mac    # browse stop on the Mac (drained; tabs stay)
```

A browser shows as disconnected until its profile is open. Ask Safzan to open it; do not drive another profile in its
place.

## Failure modes

- **HTTP 401**: `~/.opencode-browser-mac/relay-token` is missing or stale (the Mac's was regenerated). Run `sync`.
- **`isn't the Mac tunnel`** (from the launcher), **`automatic relay startup is disabled`** or a refused connection:
  the tunnel is down. Run `up`; with the service installed, `journalctl --user -u browse-mac-tunnel` shows why it
  dropped.
- **`sync` says the build is another version**: the Linux binary on the Mac is older than the Mac's own build. Rebuild
  it (above) and sync again.
- **ssh tunnel dies at once**: ampere multiplexes `mac`, so `up` passes `ControlPath=none` and binds `127.0.0.1`.
  Cancel a stray multiplexed forward with `ssh -O cancel -L 127.0.0.1:19988:127.0.0.1:19988 mac`.
- **`status` starts with `Setup: not installed`**: expected here, nothing is installed on ampere but the build copy.
  Don't run `install`.

Log and pids: `~/.opencode-browser-mac/mac-relays/` (`run.pid`, `listener.pid`, `ssh.pid`, the forwarded
`relay.sock`, and `ssh.log` for a manual `up`); the service logs to the journal.
