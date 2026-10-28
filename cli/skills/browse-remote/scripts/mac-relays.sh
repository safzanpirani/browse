#!/usr/bin/env bash
# Run on ampere (any Linux host with the `mac` ssh alias). Lets `browse` here drive the Mac's browser profiles:
# ssh tunnels to the Mac's browse relays plus relay-proxy.mjs, which rewrites Host back to the Mac port.
#
#   mac-relays.sh sync                 # pull the Mac's built CLI, its relay token, this skill and the browse skill
#   mac-relays.sh up [port...]         # tunnel every profile in the Mac's profiles.json (or the given Mac ports)
#   mac-relays.sh status               # tunnel and proxy processes, each relay's /extension/status (with the token)
#   mac-relays.sh start-mac <port>...  # start (or restart) a relay on the Mac with the Mac's browse
#   mac-relays.sh stop-mac <port>...   # stop a relay the Mac's browse runs
#   mac-relays.sh down
#
# Mac relay port P is reachable here on P+10000 (the proxy); the tunnel itself is P+20000. `up` writes the Mac's
# profiles into this host's data root with those ports, so `browse --profile <name>` needs no port. The relay token is
# sent only to listeners this script started and confirmed (the proxy's ready marker, the tunnel's own sockets).
# Overrides: BROWSE_MAC_HOST (mac), BROWSE_MAC_LAUNCHER (the Mac's ~/.local/bin/browse), BROWSE_MAC_HOME (the Mac's
# data root, ~/.local/share/opencode-browser), BROWSE_MAC_SKILL (the Mac's installed ~/.agents/skills/browse),
# BROWSE_APP (~/apps/browse here).
set -uo pipefail

mac="${BROWSE_MAC_HOST:-mac}"
# This host's OPENCODE_BROWSER_HOME: the Mac's token and profiles, never a local relay's.
home="$HOME/.opencode-browser-mac"
app="${BROWSE_APP:-$HOME/apps/browse}"
launcher="$HOME/.local/bin/browse"
skill="$HOME/.agents/skills/browse-remote"
browse_skill="$HOME/.agents/skills/browse"
state="$home/mac-relays"
here="$(cd "$(dirname "$0")" && pwd)"
marker="# Written by browse-remote's mac-relays.sh sync, which rewrites it."
# The browse skill's own line, in place of the Mac install's marker; a browse skill without it is left alone.
skill_marker="<!-- Written by browse-remote's mac-relays.sh sync, which rewrites it. -->"

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
mac_home="$(mac_path "${BROWSE_MAC_HOME:-}" .local/share/opencode-browser)"
mac_skill="$(mac_path "${BROWSE_MAC_SKILL:-}" .agents/skills/browse)"
# The same paths for messages.
mac_launcher_name="${BROWSE_MAC_LAUNCHER:-~/.local/bin/browse}"
mac_home_name="${BROWSE_MAC_HOME:-~/.local/share/opencode-browser}"
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

# A Mac relay port: plain decimal (no leading zero, which bash would read as octal), and never browser-control's.
check_port() {
  [[ $1 =~ ^[1-9][0-9]{0,4}$ ]] && (( $1 <= 65535 )) || die "not a port: $1"
  (( $1 >= 19989 && $1 <= 19995 )) && die "port $1 is browser-control's; browse relays use 19960-19966 (or 19988)"
  return 0
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
# Records a process this script started as "<pid> <start time>" in $state/<name>.pid.
record() {
  local started
  started="$(start_time "$2")" || return 1
  printf '%s %s\n' "$2" "$started" > "$state/$1.pid"
}
# Prints the recorded pid while it is still that process; fails (and signals nothing) otherwise.
owned() {
  local pid started
  [[ -s $state/$1.pid ]] && read -r pid started < "$state/$1.pid" || return 1
  [[ -n $started && $(start_time "$pid") == "$started" ]] && printf '%s' "$pid"
}
stop() {
  local pid
  for f in ssh proxy; do
    pid="$(owned "$f")" && kill "$pid"
    rm -f "$state/$f.pid"
  done
  rm -f "$state/ready"
}

# Whether <pid> holds the listening socket on 127.0.0.1:<port>. (Not `ss | grep -q`: with pipefail, grep's early exit
# fails the pipeline.)
listens() { [[ $(ss -Hltnp "sport = :$1" 2>/dev/null) == *"pid=$2,"* ]]; }
# Sets ssh_pid and proxy_pid when both are this script's and the proxy confirmed every port in $state/ports.
confirmed() {
  local ports
  ssh_pid="$(owned ssh)" && proxy_pid="$(owned proxy)" && [[ -s $state/ports && -s $state/ready ]] || return 1
  mapfile -t ports < "$state/ports"
  [[ $(<"$state/ready") == "$proxy_pid ${ports[*]}" ]]
}
# Whether Mac port <p>'s proxy and tunnel sockets belong to the confirmed proxy and ssh.
port_ours() { listens "$(( $1 + 10000 ))" "$proxy_pid" && listens "$(( $1 + 20000 ))" "$ssh_pid"; }

# curl with the relay token as a header read from stdin, so it never shows in argv.
authed_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "$(<"$home/relay-token")" | curl -s -K - "$@"
}

ssh_pid=""
proxy_pid=""
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
    echo "✓ relay token at $home/relay-token"

    if [[ -e $launcher ]] && ! grep -qxF "$marker" "$launcher"; then
      echo "! $launcher exists and isn't this script's; left it alone" >&2
    else
      mkdir -p "$(dirname "$launcher")" || die "cannot create $(dirname "$launcher")"
      cat > "$launcher.tmp" <<EOF || die "cannot write $launcher.tmp"
#!/bin/sh
# browse: drives the Mac's browser through the tunnels \`mac-relays.sh up\` opens (skill browse-remote).
$marker
# No local relay: a call to a port nothing listens on fails instead of starting one that grabs it.
export OPENCODE_BROWSER_AUTOSTART=false
export OPENCODE_BROWSER_HOME="\$HOME/.opencode-browser-mac"
# Updates come from \`mac-relays.sh sync\`, not this copy.
export OPENCODE_BROWSER_UPDATE_CHECK=0
# Commands the CLI prints (next steps, hints) start with this name.
export OPENCODE_BROWSER_COMMAND=browse
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

    # The Mac's installed browse skill (the driving API, with its profile table), with this script's marker and a note
    # on this host in place of the Mac install's marker. A browse skill here without the marker is someone else's.
    if [[ -e $browse_skill ]] && ! grep -qxF "$skill_marker" "$browse_skill/SKILL.md" 2>/dev/null; then
      echo "! $browse_skill exists and isn't this script's; left it alone" >&2
    else
      rm -rf "$browse_skill.new" && mkdir -p "$browse_skill.new" || die "cannot create $browse_skill.new"
      on_mac "COPYFILE_DISABLE=1 tar -C $mac_skill -czf - ." | tar --warning=no-unknown-keyword -xzf - -C "$browse_skill.new" \
        && [[ -s $browse_skill.new/SKILL.md ]] \
        || { rm -rf "$browse_skill.new"; die "cannot copy the browse skill from $mac:$mac_skill_name (\`browse install --client omp\` writes it there)"; }
      note="> **On $(hostname -s):** \`browse\` drives the Mac's profiles through \`~/.agents/skills/browse-remote/scripts/mac-relays.sh up\`, at Mac port + 10000; \`--profile <name>\` and \`browse find\` work unchanged, but journals and \`files.write()\` output stay on the Mac. Never run \`browse install\`, \`update\` or \`profiles add|remove|sync\` here (skill browse-remote)."
      awk -v marker="$skill_marker" -v note="$note" '
        /^<!-- Written by `opencode-browser install/ { next }
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
    shift
    stop
    # The Mac's profiles.json is the one source of ports and names.
    on_mac "cat $mac_home/profiles.json 2>/dev/null || echo '{\"profiles\":[]}'" > "$state/mac-profiles.json.new" \
      || die "cannot reach $mac over ssh"
    mv "$state/mac-profiles.json.new" "$state/mac-profiles.json"
    # Here each profile's port is its proxy port, so `browse --profile <name>` goes through the tunnel.
    mapfile -t profile_ports < <(node -e '
      const fs = require("fs")
      const [source, target] = process.argv.slice(1)
      const profiles = JSON.parse(fs.readFileSync(source, "utf8")).profiles ?? []
      const shifted = profiles.map(({ extension, ...profile }) => ({ ...profile, port: profile.port + 10000 }))
      fs.writeFileSync(`${target}.tmp`, `${JSON.stringify({ version: 1, profiles: shifted }, null, 2)}\n`)
      fs.renameSync(`${target}.tmp`, target)
      for (const profile of profiles) console.log(profile.port)
    ' "$state/mac-profiles.json" "$home/profiles.json") || die "the Mac's profiles.json isn't valid"
    ports=("$@")
    (( ${#ports[@]} )) || ports=("${profile_ports[@]}")
    (( ${#ports[@]} )) || die "no browse profiles on the Mac (\`browse profiles add <name>\` there), and no ports given"
    for p in "${ports[@]}"; do
      check_port "$p"
      (( p + 20000 <= 65535 )) || die "port $p has no room for its tunnel port $((p + 20000))"
    done
    printf '%s\n' "${ports[@]}" > "$state/ports"
    forwards=()
    for p in "${ports[@]}"; do forwards+=(-L "127.0.0.1:$((p + 20000)):127.0.0.1:$p"); done
    # 127.0.0.1 explicitly: the default also tries ::1, which ampere lacks, and ExitOnForwardFailure then aborts.
    # ControlPath=none: a multiplexed client hands its forwards to the shared master and exits, so `down` could not
    # close them.
    nohup ssh -N -o ControlPath=none -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      "${forwards[@]}" "$mac" >"$state/ssh.log" 2>&1 &
    record ssh $!
    READY_FILE="$state/ready" nohup node "$here/relay-proxy.mjs" "${ports[@]}" >"$state/proxy.log" 2>&1 &
    record proxy $!
    # Up means confirmed: the proxy wrote its ready marker after binding every port, and each tunnel port is the ssh
    # client's own socket. Anything else (a port another program holds, a dead process) stops both. ssh to the Mac
    # has taken 12-45 s to authenticate when the Mac is busy, hence the long deadline.
    deadline=$((SECONDS + 120))
    until
      confirmed && all=1 && for p in "${ports[@]}"; do port_ours "$p" || { all=0; break; }; done && (( all ))
    do
      owned ssh >/dev/null || { echo "ssh tunnel failed:" >&2; cat "$state/ssh.log" >&2; stop; exit 1; }
      owned proxy >/dev/null || { echo "proxy failed:" >&2; cat "$state/proxy.log" >&2; stop; exit 1; }
      (( SECONDS < deadline )) || { echo "tunnel and proxy not confirmed within 120 s:" >&2; cat "$state/ssh.log" "$state/proxy.log" >&2; stop; exit 1; }
      sleep 0.2
    done
    "$0" status
    ;;
  down)
    stop
    echo "mac relay tunnels closed"
    ;;
  status)
    ssh_pid="$(owned ssh)" && echo "ssh tunnel: pid $ssh_pid" || echo "ssh tunnel: not running"
    proxy_pid="$(owned proxy)" && echo "proxy:      pid $proxy_pid" || echo "proxy:      not running"
    [[ -n $ssh_pid && -n $proxy_pid ]] || exit 0
    [[ -s $home/relay-token ]] || die "no relay token at $home/relay-token; run \`$0 sync\`"
    confirmed || die "the proxy never confirmed its ports; run \`$0 up\` (no token sent)"
    while read -r p; do
      if ! port_ours "$p"; then
        echo "$((p + 10000)) (mac relay $p): not this proxy and tunnel's sockets; skipped, no token sent"
        continue
      fi
      out="$(authed_curl -m 4 -w '\n%{http_code}' "http://127.0.0.1:$((p + 10000))/extension/status")"
      body="${out%$'\n'*}"
      printf '%s (mac relay %s): HTTP %s %s\n' "$((p + 10000))" "$p" "${out##*$'\n'}" "${body:0:120}"
    done < "$state/ports"
    ;;
  start-mac)
    # `relay restart` starts a relay only on the machine whose CLI runs it, so it runs on the Mac. A relay for an idle
    # profile stays down until then, and that profile's extension cannot attach.
    shift
    (( $# )) || die "usage: mac-relays.sh start-mac <port>..."
    for p in "$@"; do check_port "$p"; done
    failed=0
    for p in "$@"; do
      on_mac "OPENCODE_BROWSER_PORT=$p $mac_launcher relay restart" 2>&1 || { echo "start-mac $p failed" >&2; failed=1; }
    done
    exit "$failed"
    ;;
  stop-mac)
    # `relay stop` drains the relay that answers on the port with this install's token; it never kills another process.
    shift
    (( $# )) || die "usage: mac-relays.sh stop-mac <port>..."
    for p in "$@"; do check_port "$p"; done
    failed=0
    for p in "$@"; do
      on_mac "OPENCODE_BROWSER_PORT=$p $mac_launcher relay stop" 2>&1 || { echo "stop-mac $p failed" >&2; failed=1; }
    done
    exit "$failed"
    ;;
  *) echo "usage: mac-relays.sh sync | up [port...] | down | status | start-mac <port>... | stop-mac <port>..." >&2; exit 2 ;;
esac
