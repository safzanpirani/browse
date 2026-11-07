#!/usr/bin/env bash
# Run on ampere (any Linux host with the `mac` ssh alias). Lets `browse` here drive every browser paired with the
# Mac's one relay: an ssh tunnel from 127.0.0.1:<port> here to the same port on the Mac, so the relay's Host check
# (it rejects a Host whose port differs from its own) passes without a proxy.
#
#   mac-relays.sh sync        # pull the Mac's built CLI, its relay token, this skill and the browse skill
#   mac-relays.sh up          # open the tunnel (restarts the service when it is installed)
#   mac-relays.sh status      # tunnel process, then the relay's /extension/status (with the token)
#   mac-relays.sh start-mac   # start (or restart) the relay on the Mac with the Mac's browse
#   mac-relays.sh stop-mac    # stop the Mac's relay (drained; tabs stay)
#   mac-relays.sh down        # close the tunnel (stops the service when it is installed)
#   mac-relays.sh check       # quiet unless 127.0.0.1:<port> isn't this script's tunnel (the launcher's guard)
#   mac-relays.sh service install|remove   # a systemd user service that keeps the tunnel up across reboots
#   mac-relays.sh run         # the service's foreground tunnel (systemd runs this; not for interactive use)
#
# The relay token is sent only to the tunnel this script started and confirmed (the ssh client's own socket).
# Overrides: BROWSE_MAC_HOST (mac), BROWSE_PORT (19988, the relay port on both hosts), BROWSE_MAC_LAUNCHER (the Mac's
# ~/.local/bin/browse), BROWSE_MAC_HOME (the Mac's data root, ~/.local/share/browse), BROWSE_MAC_SKILL (the Mac's
# installed ~/.agents/skills/browse), BROWSE_APP (~/apps/browse here).
set -uo pipefail

mac="${BROWSE_MAC_HOST:-mac}"
port="${BROWSE_PORT:-19988}"
# This host's OPENCODE_BROWSER_HOME: the Mac's token, never a local relay's.
home="$HOME/.opencode-browser-mac"
app="${BROWSE_APP:-$HOME/apps/browse}"
launcher="$HOME/.local/bin/browse"
skill="$HOME/.agents/skills/browse-remote"
browse_skill="$HOME/.agents/skills/browse"
state="$home/mac-relays"
marker="# Written by browse-remote's mac-relays.sh sync, which rewrites it."
# The browse skill's own line, in place of the Mac install's marker; a browse skill without it is left alone.
skill_marker="<!-- Written by browse-remote's mac-relays.sh sync, which rewrites it. -->"
unit_name="browse-mac-tunnel.service"
unit="$HOME/.config/systemd/user/$unit_name"

[[ $port =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || { echo "not a port: $port" >&2; exit 1; }
mkdir -p "$state" && chmod 700 "$home" "$state" || { echo "cannot create $state" >&2; exit 1; }

on_mac() { ssh -o BatchMode=yes -o ConnectTimeout=8 "$mac" "$@"; }
die() { echo "$*" >&2; exit 1; }
# One shell word, for a command line the Mac's shell or this host's launcher parses.
shq() { local q="'\\''"; printf "'%s'" "${1//\'/$q}"; }
# A Mac path as one word for the Mac's shell: an override is taken literally (quoted, so `$`, backticks and `$(…)` in
# it are never run there); the default, under $HOME, expands on the Mac. A suffix goes after it unquoted
# ("$mac_home/relay-token"), which the Mac's shell joins into the same word.
mac_path() { if [[ -n $1 ]]; then shq "$1"; else printf '"$HOME/%s"' "$2"; fi; }
mac_launcher="$(mac_path "${BROWSE_MAC_LAUNCHER:-}" .local/bin/browse)"
mac_home="$(mac_path "${BROWSE_MAC_HOME:-}" .local/share/browse)"
mac_skill="$(mac_path "${BROWSE_MAC_SKILL:-}" .agents/skills/browse)"
# The same paths for messages.
mac_launcher_name="${BROWSE_MAC_LAUNCHER:-~/.local/bin/browse}"
mac_home_name="${BROWSE_MAC_HOME:-~/.local/share/browse}"
mac_skill_name="${BROWSE_MAC_SKILL:-~/.agents/skills/browse}"
# Replaces folder <dest> with folder <new> by rename, so this running script and readers never see it half-written.
swap_in() {
  rm -rf "$2.old"
  if [[ -d $2 ]]; then mv "$2" "$2.old" || die "cannot move $2 aside"; fi
  if ! mv "$1" "$2"; then
    [[ -d $2.old ]] && mv "$2.old" "$2"
    die "cannot install $2"
  fi
  rm -rf "$2.old"
}

# The CLI entry the Mac's launcher runs (its exec line, as omp's install writes it).
mac_entry() {
  local entry
  entry="$(on_mac "cat $mac_launcher" | sed -n "s/^exec '[^']*' '\([^']*\)' .*/\1/p")"
  [[ $entry == /*/dist/cli.mjs ]] || die "cannot read the CLI path from the Mac's launcher ($mac_launcher_name); is browse installed there?"
  printf '%s' "$entry"
}

# A live process's start time (clock ticks after boot), which a reused pid does not share. Fails for a zombie.
start_time() {
  local stat fields
  [[ $1 =~ ^[0-9]+$ && -r /proc/$1/stat ]] || return 1
  stat="$(<"/proc/$1/stat")" || return 1
  read -ra fields <<<"${stat##*) }"
  [[ ${fields[0]} != Z ]] && printf '%s' "${fields[19]}"
}
# The tunnel is three processes, each recorded as "<pid> <start time> <port>" in $state/<name>.pid:
#   run       this script's `run` loop (the systemd service's main process, or a manual `up`'s background job)
#   listener  socat on 127.0.0.1:<port>, held for the whole run, forwarding each connection to $sock
#   ssh       the current ssh client, which forwards $sock to the Mac's 127.0.0.1:<port>; `run` restarts it
# The listener never closes while ssh reconnects, so no other program can take the port in that gap and receive the
# relay token. A connection made while ssh is down reaches no relay and is closed.
sock="$state/relay.sock"
record() {
  local started
  started="$(start_time "$2")" || return 1
  printf '%s %s %s\n' "$2" "$started" "$port" > "$state/$1.pid"
}
# Prints <name>'s recorded pid while it is still that process for this port; fails (and signals nothing) otherwise.
owned() {
  local pid started recorded_port
  [[ -s $state/$1.pid ]] && read -r pid started recorded_port < "$state/$1.pid" || return 1
  [[ -n $started && $recorded_port == "$port" && $(start_time "$pid") == "$started" ]] && printf '%s' "$pid"
}
# Stops every process this script recorded (any port), the per-profile layout's proxy included.
stop() {
  local f pid started
  for f in run listener ssh proxy; do
    if [[ -s $state/$f.pid ]] && read -r pid started _ < "$state/$f.pid" \
      && [[ -n $started && $(start_time "$pid") == "$started" ]]; then
      kill "$pid"
    fi
    rm -f "$state/$f.pid"
  done
  rm -f "$state/ready" "$state/ports" "$state/mac-profiles.json"
}

# Whether <pid> holds the listening socket on 127.0.0.1:<port>. (Not `ss | grep -q`: with pipefail, grep's early exit
# fails the pipeline.)
listens() { [[ $(ss -Hltnp "sport = :$1" 2>/dev/null) == *"pid=$2,"* ]]; }
# The launcher's guard: the port is our listener's own socket, and an ssh client of this run is alive and has
# authenticated (it creates $sock only then).
tunnel_ok() {
  local pid
  pid="$(owned listener)" && listens "$port" "$pid" && owned ssh >/dev/null && [[ -S $sock ]]
}

# curl with the relay token as a header read from stdin, so it never shows in argv. `-q` (first) skips ~/.curlrc and
# --noproxy keeps proxy variables from routing the token anywhere but the tunnel.
authed_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "$(<"$home/relay-token")" | curl -q --noproxy '*' -s -K - "$@"
}

# The tunnel's ssh options. ControlPath=none: a multiplexed client hands its forward to the shared master and exits, so
# `down` could not close it. BatchMode: neither the service nor a background `up` can answer a prompt.
ssh_opts=(-N -o BatchMode=yes -o ControlPath=none -o ExitOnForwardFailure=yes -o StreamLocalBindUnlink=yes
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3)

# Waits until tunnel_ok; ssh to the Mac has taken 12-45 s to authenticate when the Mac is busy, hence the long deadline.
# <log command> prints the tunnel's log on failure. Under systemd a dead attempt is retried, so only the deadline fails.
confirm() {
  local deadline=$((SECONDS + 120))
  until tunnel_ok; do
    if [[ ! -e $unit ]] && ! owned run >/dev/null; then
      echo "tunnel failed:" >&2; eval "$1" >&2; stop; exit 1
    fi
    (( SECONDS < deadline )) || { echo "tunnel not confirmed within 120 s:" >&2; eval "$1" >&2; [[ -e $unit ]] || stop; exit 1; }
    sleep 0.2
  done
}
# A service installed for another port or host would make `up` silently restart that one instead.
unit_matches() {
  grep -qxF "Environment=BROWSE_PORT=$port BROWSE_MAC_HOST=$mac" "$unit" \
    || die "$unit_name was installed for another port or host; run \`$0 service install\` with these settings"
}

case "${1:-status}" in
  sync)
    command -v node >/dev/null || die "node is not on PATH"
    command -v bun >/dev/null || die "bun is not on PATH (it installs the CLI's dependencies)"
    entry="$(mac_entry)" || exit 1
    cli="${entry%/dist/cli.mjs}"
    live="$app/cli"
    # One sync at a time, through the whole run (release, token, launcher, skill, cleanup): they share these paths.
    mkdir -p "$app/releases" || die "cannot create $app/releases"
    exec 9>"$app/.sync.lock" || die "cannot open $app/.sync.lock"
    if ! flock -n 9; then
      echo "another mac-relays.sh sync holds $app/.sync.lock; waiting up to 10 min" >&2
      flock -w 600 9 || die "gave up waiting for $app/.sync.lock"
    fi
    # The new CLI is assembled in its own release folder; $app/cli, a symlink, switches to it in one rename once it
    # is complete, so an interrupted sync leaves the old CLI working and the next sync starts over.
    next="$app/releases/$(date +%Y%m%d-%H%M%S)-$$"
    link="$app/cli.tmp.$$"
    mkdir "$next" || die "cannot create $next"
    # Never removes the release $app/cli points at, even when this sync fails after switching to it.
    discard() {
      [[ $(readlink -f "$live") == "$(readlink -f "$next")" ]] || rm -rf "$next"
      rm -f "$link"
    }
    trap discard EXIT
    on_mac "COPYFILE_DISABLE=1 tar -C $(shq "$cli") -czf - dist package.json bun.lock skills/browse-remote" \
      | tar --warning=no-unknown-keyword -xzf - -C "$next" \
      || die "cannot copy the built CLI from $mac:$cli"
    [[ -s $next/dist/cli.mjs ]] || die "$mac:$cli has no built dist/cli.mjs"
    deps="$(cat "$next/package.json" "$next/bun.lock" | sha256sum | cut -d' ' -f1)"
    # .deps names the manifests a release's node_modules was installed from; it is written only after that worked.
    if [[ -d $live/node_modules && -s $live/.deps && $(<"$live/.deps") == "$deps" ]]; then
      cp -al "$live/node_modules" "$next/node_modules" || die "cannot link node_modules into $next"
    else
      (cd "$next" && bun install --production --frozen-lockfile --ignore-scripts) || die "bun install failed in $next"
    fi
    printf '%s\n' "$deps" > "$next/.deps" || die "cannot write $next/.deps"
    OPENCODE_BROWSER_HOME="$home" OPENCODE_BROWSER_AUTOSTART=false OPENCODE_BROWSER_UPDATE_CHECK=0 \
      node "$next/dist/cli.mjs" --version >/dev/null || die "the new CLI in $next does not run"
    legacy=""
    if [[ -d $live && ! -L $live ]]; then
      # An install from before releases: a plain folder. Moved aside once, put back if the switch fails.
      legacy="$app/releases/00000000-legacy-$$"
      mv "$live" "$legacy" || die "cannot move $live aside"
    fi
    if ! { ln -sfn "releases/${next##*/}" "$link" && mv -T "$link" "$live"; }; then
      [[ -n $legacy ]] && mv "$legacy" "$live"
      die "cannot switch $live to $next"
    fi
    trap - EXIT
    # The previous release stays, for a command still running from it; the one $app/cli points at always stays.
    active="$(readlink -f "$live")"
    ls -1d "$app/releases"/* | sort | head -n -2 | while read -r old; do
      [[ $(readlink -f "$old") == "$active" ]] || rm -rf "$old"
    done
    echo "✓ CLI from $mac:$cli at $live → releases/${next##*/} ($(md5sum < "$live/dist/cli.mjs" | cut -c1-12))"

    # The token goes through ssh stdout into a 0600 file; it is never printed or passed as an argument.
    (umask 077 && on_mac "cat $mac_home/relay-token" > "$home/relay-token.tmp") && [[ -s $home/relay-token.tmp ]] \
      || { rm -f "$home/relay-token.tmp"; die "cannot read the Mac's relay token at $mac_home_name/relay-token"; }
    mv "$home/relay-token.tmp" "$home/relay-token" || die "cannot write $home/relay-token"
    # The per-profile layout's profile list; the one relay replaces it.
    rm -f "$home/profiles.json" "$home/profiles.json.lock"
    echo "✓ relay token at $home/relay-token"

    if [[ -e $launcher ]] && ! grep -qxF "$marker" "$launcher"; then
      echo "! $launcher exists and isn't this script's; left it alone" >&2
    else
      mkdir -p "$(dirname "$launcher")" || die "cannot create $(dirname "$launcher")"
      cat > "$launcher.tmp" <<EOF || die "cannot write $launcher.tmp"
#!/bin/sh
# browse: drives the Mac's browsers through the tunnel \`mac-relays.sh up\` opens (skill browse-remote).
$marker
# No local relay: with the tunnel down a call fails instead of starting one that grabs the port.
export OPENCODE_BROWSER_AUTOSTART=false
export OPENCODE_BROWSER_HOME="\$HOME/.opencode-browser-mac"
export OPENCODE_BROWSER_PORT=$port
# Updates come from \`mac-relays.sh sync\`, not this copy.
export OPENCODE_BROWSER_UPDATE_CHECK=0
# Commands the CLI prints (next steps, hints) start with this name.
export OPENCODE_BROWSER_COMMAND=browse
# The CLI sends the relay token on every call, so it runs only while 127.0.0.1:$port is this script's own tunnel.
# A long-lived server would keep sending it after the tunnel closed, so mcp and serve don't run here.
# The CLI accepts flags before the command, so any argument before \`--\` that names one refuses the call.
for arg in "\$@"; do
  case \$arg in
    --) break ;;
    mcp|serve) echo "browse: \$arg doesn't run over the Mac tunnel; use the CLI (skill browse-remote)" >&2; exit 1 ;;
  esac
done
BROWSE_PORT=$port $(shq "$skill/scripts/mac-relays.sh") check || exit 1
exec $(shq "$(command -v node)") $(shq "$live/dist/cli.mjs") "\$@"
EOF
      chmod 755 "$launcher.tmp" && mv "$launcher.tmp" "$launcher" || die "cannot install $launcher"
      echo "✓ launcher at $launcher"
    fi

    # Swapped in by rename, so this running script keeps reading its old copy.
    mkdir -p "$(dirname "$skill")" || die "cannot create $(dirname "$skill")"
    rm -rf "$skill.new"
    cp -R "$live/skills/browse-remote" "$skill.new" || die "cannot copy the skill to $skill.new"
    swap_in "$skill.new" "$skill"
    echo "✓ skill at $skill"

    # The Mac's installed browse skill (the driving API, with its browser table), with this script's marker and a note
    # on this host in place of the Mac install's marker. A browse skill here without the marker is someone else's.
    if [[ -e $browse_skill ]] && ! grep -qxF "$skill_marker" "$browse_skill/SKILL.md" 2>/dev/null; then
      echo "! $browse_skill exists and isn't this script's; left it alone" >&2
    else
      rm -rf "$browse_skill.new" && mkdir -p "$browse_skill.new" || die "cannot create $browse_skill.new"
      on_mac "COPYFILE_DISABLE=1 tar -C $mac_skill -czf - ." | tar --warning=no-unknown-keyword -xzf - -C "$browse_skill.new" \
        && [[ -s $browse_skill.new/SKILL.md ]] \
        || { rm -rf "$browse_skill.new"; die "cannot copy the browse skill from $mac:$mac_skill_name (\`browse install --client omp\` writes it there)"; }
      note="> **On $(hostname -s):** \`browse\` drives the Mac's relay through \`~/.agents/skills/browse-remote/scripts/mac-relays.sh up\` (127.0.0.1:$port, tunnelled); \`--profile <name>\` and \`browse find\` work unchanged, but journals and \`files.write()\` output stay on the Mac. Never run \`browse install\`, \`update\`, \`pair\` or \`relay\` commands here (skill browse-remote)."
      awk -v marker="$skill_marker" -v note="$note" '
        /^<!-- Written by `(opencode-browser|browse) install/ { next }
        { print }
        $0 == "---" && ++fences == 2 { print marker; print ""; print note }
      ' "$browse_skill.new/SKILL.md" > "$browse_skill.new/SKILL.md.tmp" \
        && mv "$browse_skill.new/SKILL.md.tmp" "$browse_skill.new/SKILL.md" \
        && grep -qxF "$skill_marker" "$browse_skill.new/SKILL.md" \
        || { rm -rf "$browse_skill.new"; die "the browse skill from $mac:$mac_skill_name has no frontmatter to mark"; }
      swap_in "$browse_skill.new" "$browse_skill"
      echo "✓ browse skill at $browse_skill"
    fi
    ;;
  up)
    if [[ -e $unit ]]; then
      unit_matches
      systemctl --user restart "$unit_name" || die "cannot restart $unit_name"
      confirm "journalctl --user -u $unit_name -n 20 --no-pager"
    else
      stop
      nohup bash "$0" run >"$state/ssh.log" 2>&1 &
      confirm "cat $state/ssh.log"
    fi
    bash "$0" status
    ;;
  run)
    # The service's ExecStart (and a manual `up`'s background job): hold the port with socat for the whole run and
    # keep an ssh client forwarding $sock to the Mac, reconnecting 5 s after it drops.
    command -v socat >/dev/null || die "socat is not on PATH"
    stop
    record run $$ || die "cannot record the run pid"
    rm -f "$sock"
    children=()
    trap 'kill "${children[@]}" 2>/dev/null; rm -f "$sock"' EXIT
    trap 'exit 0' TERM INT
    socat "TCP-LISTEN:$port,bind=127.0.0.1,reuseaddr,fork" "UNIX-CONNECT:$sock" &
    listener=$!
    children+=("$listener")
    record listener "$listener" || die "socat exited at once (another program holds 127.0.0.1:$port?)"
    for _ in {1..25}; do
      listens "$port" "$listener" && break
      kill -0 "$listener" 2>/dev/null || die "socat cannot listen on 127.0.0.1:$port (another program holds it?)"
      sleep 0.2
    done
    listens "$port" "$listener" || die "socat did not bind 127.0.0.1:$port"
    while kill -0 "$listener" 2>/dev/null; do
      # A killed ssh can leave its socket behind; removing it means $sock exists only once this ssh has authenticated.
      rm -f "$sock"
      ssh "${ssh_opts[@]}" -L "$sock:127.0.0.1:$port" "$mac" &
      children+=("$!")
      record ssh "$!"
      wait "$!"
      echo "ssh exited ($?); reconnecting in 5 s" >&2
      sleep 5
    done
    die "the listener exited"
    ;;
  service)
    case "${2:-}" in
      install)
        command -v systemctl >/dev/null || die "systemctl is not on PATH"
        command -v socat >/dev/null || die "socat is not on PATH"
        [[ -x $skill/scripts/mac-relays.sh ]] || die "$skill/scripts/mac-relays.sh is missing; run \`$0 sync\` first"
        [[ -e $unit ]] && { systemctl --user stop "$unit_name" || die "cannot stop $unit_name"; }
        stop
        mkdir -p "$(dirname "$unit")" || die "cannot create $(dirname "$unit")"
        cat > "$unit.tmp" <<EOF || die "cannot write $unit.tmp"
[Unit]
Description=browse: ssh tunnel to the Mac's relay (127.0.0.1:$port)
After=network-online.target
Wants=network-online.target

[Service]
Environment=BROWSE_PORT=$port BROWSE_MAC_HOST=$mac
ExecStart=$skill/scripts/mac-relays.sh run
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
        mv "$unit.tmp" "$unit" && systemctl --user daemon-reload && systemctl --user enable --now "$unit_name" \
          || die "cannot enable $unit_name"
        confirm "journalctl --user -u $unit_name -n 20 --no-pager"
        echo "✓ $unit_name enabled"
        bash "$0" status
        ;;
      remove)
        if [[ -e $unit ]]; then
          systemctl --user disable --now "$unit_name" || die "cannot stop and disable $unit_name; left it installed"
          rm -f "$unit" && systemctl --user daemon-reload
        fi
        stop
        echo "✓ $unit_name removed"
        ;;
      *) die "usage: mac-relays.sh service install|remove" ;;
    esac
    ;;
  down)
    # A supervised tunnel is stopped through systemd only: killing it directly would just make systemd restart it.
    if [[ -e $unit ]]; then
      systemctl --user stop "$unit_name" || die "cannot stop $unit_name; the tunnel may still be up"
    fi
    stop
    echo "mac relay tunnel closed$([[ -e $unit ]] && echo " (the service starts it again at the next boot or \`up\`)")"
    ;;
  check)
    # Quiet unless it fails: the launcher's guard before any call that carries the token.
    tunnel_ok || die "browse: 127.0.0.1:$port isn't the Mac tunnel; run \`$skill/scripts/mac-relays.sh up\` (no token sent)"
    ;;
  status)
    run_pid="$(owned run)" || { echo "tunnel: not running"; exit 0; }
    echo "tunnel: run $run_pid, listener $(owned listener || echo none) on 127.0.0.1:$port, ssh $(owned ssh || echo 'none (reconnecting)') → $mac:$port"
    [[ -s $home/relay-token ]] || die "no relay token at $home/relay-token; run \`$0 sync\`"
    tunnel_ok || die "127.0.0.1:$port isn't this tunnel's listener, or ssh is down; no token sent"
    out="$(authed_curl -m 4 -w '\n%{http_code}' "http://127.0.0.1:$port/extension/status")"
    body="${out%$'\n'*}"
    printf 'relay %s: HTTP %s %s\n' "$port" "${out##*$'\n'}" "${body:0:400}"
    ;;
  start-mac)
    # `relay restart` starts a relay only on the machine whose CLI runs it, so it runs on the Mac.
    on_mac "OPENCODE_BROWSER_PORT=$port $mac_launcher relay restart" 2>&1 || die "start-mac failed"
    ;;
  stop-mac)
    # `relay stop` drains the relay that answers on the port with this install's token; it never kills another process.
    on_mac "OPENCODE_BROWSER_PORT=$port $mac_launcher relay stop" 2>&1 || die "stop-mac failed"
    ;;
  *) echo "usage: mac-relays.sh sync | up | down | status | check | service install|remove | start-mac | stop-mac" >&2; exit 2 ;;
esac
