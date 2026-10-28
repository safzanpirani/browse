#!/usr/bin/env bash
# Run on ampere (any Linux host with the `mac` ssh alias). Lets `browse` here drive the Mac's browser profiles:
# ssh tunnels to the Mac's browse relays plus relay-proxy.mjs, which rewrites Host back to the Mac port.
#
#   mac-relays.sh sync                 # pull the Mac's built CLI, its relay token and this skill; deps when changed
#   mac-relays.sh up [port...]         # tunnel every profile in the Mac's profiles.json (or the given Mac ports)
#   mac-relays.sh status               # tunnel and proxy processes, each relay's /extension/status (with the token)
#   mac-relays.sh start-mac <port>...  # start (or restart) a relay on the Mac with the Mac's browse
#   mac-relays.sh stop-mac <port>...   # stop a relay on the Mac
#   mac-relays.sh down
#
# Mac relay port P is reachable here on P+10000 (the proxy); the tunnel itself is P+20000. `up` writes the Mac's
# profiles into this host's data root with those ports, so `browse --profile <name>` needs no port.
# Overrides: BROWSE_MAC_HOST (mac), BROWSE_MAC_LAUNCHER (the Mac's ~/.local/bin/browse), BROWSE_MAC_HOME (the Mac's
# data root, ~/.local/share/opencode-browser), BROWSE_APP (~/apps/browse here).
set -uo pipefail

mac="${BROWSE_MAC_HOST:-mac}"
# Expanded by the Mac's shell.
mac_launcher="${BROWSE_MAC_LAUNCHER:-\$HOME/.local/bin/browse}"
mac_home="${BROWSE_MAC_HOME:-\$HOME/.local/share/opencode-browser}"
# This host's OPENCODE_BROWSER_HOME: the Mac's token and profiles, never a local relay's.
home="$HOME/.opencode-browser-mac"
app="${BROWSE_APP:-$HOME/apps/browse}"
launcher="$HOME/.local/bin/browse"
skill="$HOME/.agents/skills/browse-remote"
state="$home/mac-relays"
here="$(cd "$(dirname "$0")" && pwd)"
marker="# Written by browse-remote's mac-relays.sh sync, which rewrites it."

mkdir -p "$state"
chmod 700 "$home" "$state"

on_mac() { ssh -o BatchMode=yes -o ConnectTimeout=8 "$mac" "$@"; }
alive() { [[ -s $1 ]] && kill -0 "$(cat "$1")" 2>/dev/null; }
die() { echo "$*" >&2; exit 1; }

stop() {
  for f in ssh proxy; do
    alive "$state/$f.pid" && kill "$(cat "$state/$f.pid")"
    rm -f "$state/$f.pid"
  done
}

# browser-control's relays on the Mac; this script never starts or stops them.
check_port() {
  [[ $1 =~ ^[0-9]+$ ]] || die "not a port: $1"
  (( $1 >= 19989 && $1 <= 19995 )) && die "port $1 is browser-control's; browse relays use 19960-19966 (or 19988)"
  return 0
}

# curl with the relay token as a header read from stdin, so it never shows in argv.
authed_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "$(<"$home/relay-token")" | curl -s -K - "$@"
}

case "${1:-status}" in
  sync)
    command -v node >/dev/null || die "node is not on PATH"
    command -v bun >/dev/null || die "bun is not on PATH (it installs the CLI's dependencies)"
    entry="$(on_mac "cat \"$mac_launcher\"" | sed -n "s/^exec '[^']*' '\([^']*\)' .*/\1/p")"
    [[ $entry == */dist/cli.mjs ]] || die "cannot read the CLI path from the Mac's launcher ($mac_launcher); is browse installed there?"
    cli="${entry%/dist/cli.mjs}"
    mkdir -p "$app/cli"
    incoming="$(mktemp -d "$app/.sync.XXXXXX")"
    trap 'rm -rf "$incoming"' EXIT
    on_mac "COPYFILE_DISABLE=1 tar -C '$cli' -czf - dist package.json bun.lock skills/browse-remote" \
      | tar --warning=no-unknown-keyword -xzf - -C "$incoming" \
      || die "cannot copy the built CLI from $mac:$cli"
    [[ -s $incoming/dist/cli.mjs ]] || die "$mac:$cli has no built dist/cli.mjs"
    deps=0
    cmp -s "$incoming/package.json" "$app/cli/package.json" && cmp -s "$incoming/bun.lock" "$app/cli/bun.lock" \
      && [[ -d $app/cli/node_modules ]] || deps=1
    rm -rf "$app/cli/dist" "$app/cli/skills"
    mv "$incoming/dist" "$incoming/skills" "$incoming/package.json" "$incoming/bun.lock" "$app/cli/"
    if (( deps )); then
      (cd "$app/cli" && bun install --production --frozen-lockfile --ignore-scripts) || die "bun install failed in $app/cli"
    fi
    echo "✓ CLI from $mac:$cli at $app/cli ($(md5sum < "$app/cli/dist/cli.mjs" | cut -c1-12))"

    # The token goes through ssh stdout into a 0600 file; it is never printed or passed as an argument.
    (umask 077 && on_mac "cat \"$mac_home/relay-token\"" > "$home/relay-token.tmp") && [[ -s $home/relay-token.tmp ]] \
      || { rm -f "$home/relay-token.tmp"; die "cannot read the Mac's relay token at $mac_home/relay-token"; }
    mv "$home/relay-token.tmp" "$home/relay-token"
    echo "✓ relay token at $home/relay-token"

    if [[ -e $launcher ]] && ! grep -qxF "$marker" "$launcher"; then
      echo "! $launcher exists and isn't this script's; left it alone" >&2
    else
      mkdir -p "$(dirname "$launcher")"
      cat > "$launcher.tmp" <<EOF
#!/bin/sh
# browse: drives the Mac's browser through the tunnels \`mac-relays.sh up\` opens (skill browse-remote).
$marker
# No local relay: a call to a port nothing listens on fails instead of starting one that grabs it.
export OPENCODE_BROWSER_AUTOSTART=false
export OPENCODE_BROWSER_HOME="\$HOME/.opencode-browser-mac"
# Updates come from \`mac-relays.sh sync\`, not this copy.
export OPENCODE_BROWSER_UPDATE_CHECK=0
exec '$(command -v node)' '$app/cli/dist/cli.mjs' "\$@"
EOF
      chmod 755 "$launcher.tmp" && mv "$launcher.tmp" "$launcher"
      echo "✓ launcher at $launcher"
    fi

    # Swapped in by rename, so this running script keeps reading its old copy.
    mkdir -p "$(dirname "$skill")"
    rm -rf "$skill.new" "$skill.old"
    cp -R "$app/cli/skills/browse-remote" "$skill.new" || die "cannot copy the skill to $skill.new"
    [[ -d $skill ]] && mv "$skill" "$skill.old"
    mv "$skill.new" "$skill" && rm -rf "$skill.old"
    echo "✓ skill at $skill"
    ;;
  up)
    shift
    stop
    # The Mac's profiles.json is the one source of ports and names.
    on_mac "cat \"$mac_home/profiles.json\" 2>/dev/null || echo '{\"profiles\":[]}'" > "$state/mac-profiles.json.new" \
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
    for p in "${ports[@]}"; do check_port "$p"; done
    printf '%s\n' "${ports[@]}" > "$state/ports"
    forwards=()
    for p in "${ports[@]}"; do forwards+=(-L "127.0.0.1:$((p + 20000)):127.0.0.1:$p"); done
    # 127.0.0.1 explicitly: the default also tries ::1, which ampere lacks, and ExitOnForwardFailure then aborts.
    # ControlPath=none: a multiplexed client hands its forwards to the shared master and exits, so `down` could not
    # close them.
    nohup ssh -N -o ControlPath=none -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      "${forwards[@]}" "$mac" >"$state/ssh.log" 2>&1 &
    echo $! > "$state/ssh.pid"
    nohup node "$here/relay-proxy.mjs" "${ports[@]}" >"$state/proxy.log" 2>&1 &
    echo $! > "$state/proxy.pid"
    sleep 1.5
    alive "$state/ssh.pid" || { echo "ssh tunnel failed:" >&2; cat "$state/ssh.log" >&2; stop; exit 1; }
    alive "$state/proxy.pid" || { echo "proxy failed:" >&2; cat "$state/proxy.log" >&2; stop; exit 1; }
    "$0" status
    ;;
  down)
    stop
    echo "mac relay tunnels closed"
    ;;
  status)
    alive "$state/ssh.pid" && echo "ssh tunnel: pid $(cat "$state/ssh.pid")" || echo "ssh tunnel: not running"
    alive "$state/proxy.pid" && echo "proxy:      pid $(cat "$state/proxy.pid")" || echo "proxy:      not running"
    alive "$state/proxy.pid" || exit 0
    [[ -s $home/relay-token ]] || die "no relay token at $home/relay-token; run \`$0 sync\`"
    [[ -s $state/ports ]] || die "no ports recorded; run \`$0 up\`"
    while read -r p; do
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
    for p in "$@"; do
      check_port "$p"
      on_mac "OPENCODE_BROWSER_PORT=$p \"$mac_launcher\" relay restart" 2>&1
    done
    ;;
  stop-mac)
    # Stops the relay process listening on a Mac port, and only one this CLI runs (`cli.mjs serve`).
    shift
    (( $# )) || die "usage: mac-relays.sh stop-mac <port>..."
    for p in "$@"; do
      check_port "$p"
      on_mac "pid=\$(lsof -nP -t -iTCP:$p -sTCP:LISTEN | head -n 1)
        [ -n \"\$pid\" ] || { echo 'no relay on $p'; exit 0; }
        case \"\$(ps -o command= -p \$pid)\" in
          *cli.mjs*serve*) kill \$pid && echo \"stopped relay $p (pid \$pid)\" ;;
          *) echo \"port $p is held by something else (pid \$pid); left it alone\" >&2; exit 1 ;;
        esac"
    done
    ;;
  *) echo "usage: mac-relays.sh sync | up [port...] | down | status | start-mac <port>... | stop-mac <port>..." >&2; exit 2 ;;
esac
