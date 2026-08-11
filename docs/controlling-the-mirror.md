# Controlling the mirror from a terminal

MagicMirror² runs as a **frameless, fullscreen Electron window** — `js/electron.js` sets
`frame: false` and `fullscreen: true`. There is no titlebar to close, no window to minimise, and
on a kiosk desktop there is often no <kbd>Alt</kbd>+<kbd>Tab</kbd> or <kbd>Alt</kbd>+<kbd>F4</kbd>
bound either. The mirror simply owns the screen.

That is correct behaviour for a wall display and a nuisance the first time you need the desktop
back. This page covers both halves of the problem: reaching a terminal, and driving the mirror
from it.

The Widget Manager's **Restart** button covers the common case from the browser. Everything here
is for when you want the screen itself, or the mirror will not start and you need the log.

---

## 1. Reaching a terminal over a fullscreen mirror

Whichever of these your system offers, in rough order of convenience:

| Route | How |
|---|---|
| **SSH from another machine** | `ssh pi@<mirror-ip>` — the most reliable, and it needs nothing from the desktop |
| **Terminal shortcut** | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd> on most desktops, if your window manager binds it |
| **Virtual console** | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F2</kbd> switches to a text console; <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F1</kbd> (or F7) returns to the desktop |

SSH is worth setting up before you need it. If the mirror wedges in a way that blocks the
compositor, it is the only one of the three that still works.

---

## 2. The `mm` command

A small wrapper, shipped with this module at [`scripts/mm`](../scripts/mm).

### Install

```bash
cp modules/MMM-WidgetManager/scripts/mm ~/.local/bin/mm
chmod +x ~/.local/bin/mm
```

Make sure `~/.local/bin` is on your `PATH` — most distributions add it automatically when the
directory exists, but you may need to open a new shell:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && exec bash
```

### Commands

| Command | What it does |
|---|---|
| `mm start` | Launch the mirror, detached, and wait until its web server answers |
| `mm stop` | Quit the mirror and give the screen back |
| `mm restart` | Stop, then start |
| `mm toggle` | Stop if running, start if not — useful bound to a key |
| `mm status` | Whether it is running, its PID, and the mirror and Widget Manager URLs |
| `mm log [n]` | The last *n* lines of start-up output, default 40 |

`mm` with no argument is the same as `mm status`.

### What it prints

```console
$ mm status
MagicMirror is RUNNING (pid 115883)
  mirror : http://192.168.1.42:8080/
  widgets: http://192.168.1.42:8080/widgets

$ mm restart
Stopping MagicMirror... done.
Starting MagicMirror................. up.
```

`mm start` polls the mirror's own web server rather than just spawning the process and returning,
so "up." means it is genuinely serving. On a Raspberry Pi, Electron plus a set of module helpers
can take well over a minute from cold; the script waits up to two minutes before reporting a
failure.

### Configuration

All optional:

| Variable | Default | Purpose |
|---|---|---|
| `MM_DIR` | Derived from the script's own location | Your MagicMirror root |
| `MM_LOG` | `$TMPDIR/magicmirror.log` | Where start-up output is written |
| `MM_PORT` | `8080` | The port the readiness check polls |

`MM_DIR` resolves by walking up from the script, so it works unchanged as long as you copy it from
`modules/MMM-WidgetManager/scripts/`. If you move it elsewhere, or run several mirrors, set the
variable:

```bash
MM_DIR=/opt/magicmirror mm restart
```

---

## 3. How it finds the process

The mirror is matched by its command line rather than a PID file, which nothing writes:

```bash
PATTERN="[${MM_DIR:0:1}]${MM_DIR:1}/node_modules/electron/dist/electron"
```

Two details matter.

**The bracket around the first character is not decoration.** `pgrep -f` and `pkill -f` match
against every process's full command line — *including the shell that is running the script that
contains the pattern*. Without the bracket, `mm stop` terminates its own invoking shell, and a
script that calls it dies partway through with exit code 143. Wrapping the first character in a
character class means the literal string in the source never matches itself, while the pattern
still matches the real process.

**The path is included** so that with several MagicMirror checkouts on one machine, `mm` only ever
stops the one it belongs to.

---

## 4. If you run the mirror another way

`mm` assumes a plain `electron js/electron.js` launch, optionally via a `start-magicmirror.sh` in
the MagicMirror root if one exists. If you run under **pm2**, **systemd** or **Docker**, use that
supervisor's own commands instead — and tell the Widget Manager about it so its Restart button
does the right thing:

```js
{
    module: "MMM-WidgetManager",
    config: {
        restartCommand: "pm2 restart mm"
    }
}
```

Common equivalents:

| Supervisor | Restart | Status | Log |
|---|---|---|---|
| pm2 | `pm2 restart mm` | `pm2 status` | `pm2 logs mm` |
| systemd | `sudo systemctl restart magicmirror` | `systemctl status magicmirror` | `journalctl -u magicmirror -n 50` |
| Docker | `docker restart magicmirror` | `docker ps` | `docker logs --tail 50 magicmirror` |

---

## 5. Starting the mirror at boot

The simplest reliable approach on a desktop-less Pi is cron, with a wait for the display to come
up first — `@reboot` fires well before the compositor is ready, and a mirror launched into a
missing display exits immediately:

```cron
@reboot /home/pi/.local/bin/mm-boot
```

where `mm-boot` waits for the session's runtime directory and a display socket to exist, settles a
few seconds, then calls `mm start`. Under systemd, prefer a unit with
`After=graphical-session.target` and `Restart=on-failure`, which gets you supervision for free.

---

## 6. Troubleshooting

| Symptom | Where to look |
|---|---|
| `mm start` reports "no response yet" | `mm log 80`. A module helper throwing at boot is the usual cause |
| The mirror starts, then the screen goes black | Usually the display sleeping. Check your compositor's idle settings, not MagicMirror |
| `mm status` says RUNNING but nothing is on screen | A second Electron may hold the display. `pgrep -af electron` |
| Nothing at `http://<ip>:8080` from another machine | `address` and `ipWhitelist` in `config.js`. MagicMirror binds `localhost` by default |
| `mm` not found after installing | `~/.local/bin` is not on `PATH` in this shell — open a new one |

For failures on start-up, `mm log` is almost always faster than the browser console: the module
helpers log there, and a helper that throws prevents its module from ever appearing.
