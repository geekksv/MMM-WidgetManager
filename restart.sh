#!/bin/bash
# Relaunch MagicMirror. Run detached by node_helper.js so it outlives the
# electron process it is about to kill.
#
# This is the fallback for a plain `electron js/electron.js` launch. If you run
# the mirror under pm2, systemd, Docker or `npm start`, set `restartCommand` in
# the module config instead — this script is not consulted at all when that is
# set, because a module has no business assuming how its host was started.

cd "$(dirname "$0")/../.." || exit 1

# Let the helper reply to the UI before the process goes away.
sleep 2

pkill -f 'electron js/electron.js'
sleep 3
pkill -f 'MagicMirror/node_modules/electron/dist/electron'
sleep 2

# A user-local Node install, if there is one. Absent on most setups, so this is
# conditional rather than an assumption.
[ -d "$HOME/.local/node/bin" ] && export PATH="$HOME/.local/node/bin:$PATH"

LOG="${TMPDIR:-/tmp}/mm-widgetmanager-restart.log"
OPTS=()

# Only claim a Wayland session if one is actually running. Passing
# --ozone-platform=wayland on an X11 desktop stops Electron from starting.
if [ -n "$WAYLAND_DISPLAY" ] || [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/wayland-0" ]; then
	export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
	export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
	OPTS+=(--ozone-platform=wayland)
fi

exec setsid ./node_modules/.bin/electron js/electron.js "${OPTS[@]}" \
	> "$LOG" 2>&1 < /dev/null
