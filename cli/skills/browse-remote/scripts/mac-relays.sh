#!/usr/bin/env bash
# Run on ampere (any Linux host with the `mac` ssh alias). Lets `browse` here drive every browser paired with the
# Mac's one relay: an ssh tunnel from 127.0.0.1:<port> here to the same port on the Mac, so the relay's Host check
# (it rejects a Host whose port differs from its own) passes without a proxy.
#
#   mac-relays.sh sync        # pull the Mac's built CLI, its relay token, this skill and the browse skill
#   mac-relays.sh up          # open the tunnel
#   mac-relays.sh status      # tunnel process, then the relay's /extension/status (with the token)
#   mac-relays.sh start-mac   # start (or restart) the relay on the Mac with the Mac's browse
#   mac-relays.sh stop-mac    # stop the Mac's relay (drained; tabs stay)
#   mac-relays.sh down
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
# Records the ssh process this script started as "<pid> <start time> <port>" in $state/ssh.pid.
record() {
  local started
  started="$(start_time "$1")" || return 1
  printf '%s %s %s\n' "$1" "$started" "$port" > "$state/ssh.pid"
}
# Prints the recorded pid while it is still that process, tunnelling this port; fails (and signals nothing) otherwise.
owned() {
  local pid started recorded_port
  [[ -s $state/ssh.pid ]] && read -r pid started recorded_port < "$state/ssh.pid" || return 1
  [[ -n $started && $recorded_port == "$port" && $(start_time "$pid") == "$started" ]] && printf '%s' "$pid"
}
# Stops every process this script recorded: the tunnel (ssh.pid, any port) and the per-profile layout's proxy.
stop() {
  local f pid started
  for f in ssh proxy; do
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

# curl with the relay token as a header read from stdin, so it never shows in argv.
authed_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "$(<"$home/relay-token")" | curl -s -K - "$@"
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
    stop
    # 127.0.0.1 explicitly: the default also tries ::1, which ampere lacks, and ExitOnForwardFailure then aborts.
    # ControlPath=none: a multiplexed client hands its forward to the shared master and exits, so `down` could not
    # close it.
    nohup ssh -N -o ControlPath=none -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -L "127.0.0.1:$port:127.0.0.1:$port" "$mac" >"$state/ssh.log" 2>&1 &
    record $! || die "ssh exited at once: $(cat "$state/ssh.log")"
    # Up means the tunnel port is the ssh client's own socket; another program holding it stops the tunnel. ssh to the
    # Mac has taken 12-45 s to authenticate when the Mac is busy, hence the long deadline.
    deadline=$((SECONDS + 120))
    until pid="$(owned)" && listens "$port" "$pid"; do
      owned >/dev/null || { echo "ssh tunnel failed:" >&2; cat "$state/ssh.log" >&2; stop; exit 1; }
      (( SECONDS < deadline )) || { echo "tunnel not confirmed within 120 s:" >&2; cat "$state/ssh.log" >&2; stop; exit 1; }
      sleep 0.2
    done
    "$0" status
    ;;
  down)
    stop
    echo "mac relay tunnel closed"
    ;;
  status)
    pid="$(owned)" && echo "ssh tunnel: pid $pid (127.0.0.1:$port → $mac:$port)" || { echo "ssh tunnel: not running"; exit 0; }
    [[ -s $home/relay-token ]] || die "no relay token at $home/relay-token; run \`$0 sync\`"
    listens "$port" "$pid" || die "127.0.0.1:$port isn't this tunnel's socket; run \`$0 up\` (no token sent)"
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
  *) echo "usage: mac-relays.sh sync | up | down | status | start-mac | stop-mac" >&2; exit 2 ;;
esac
