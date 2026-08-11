# MMM-WidgetManager

A single-window manager for the whole MagicMirror² screen. Open one page and you see every region
of the mirror laid out as it really is — drag widgets between regions, reorder them, edit their
settings, toggle them on and off, and save it back to `config.js`.

Most changes apply to the running mirror in about **3 seconds, without a restart**. How that works
is [explained below](#how-changes-apply); it turns out MagicMirror will let you do it, but not in
the obvious way.

![The screen map](docs/screen-map.png)

## Why this exists

Two good modules already cover parts of this job, and neither covers the part I wanted:

| | What it does |
|---|---|
| [MMM-Config](https://github.com/sdetweil/MMM-Config) | Generates a **form** for editing module settings |
| [MMM-Remote-Control](https://github.com/Jopyth/MMM-Remote-Control) | **Live control** — power, module visibility, remote actions |

Neither draws the screen as a **map you drag widgets around on**. When your mirror has a dozen
modules across thirteen regions, the question is not "what is `MMM-Foo`'s config" but "what is
actually where, and what happens if I move this". That is what this module answers.

## Install

```bash
cd ~/MagicMirror/modules
git clone https://github.com/geekksv/MMM-WidgetManager.git
```

Add it to `config.js`. No `position` is needed — the module renders nothing on the mirror itself:

```js
{
    module: "MMM-WidgetManager",
    config: {
        showUrl: false
    }
}
```

Restart the mirror once, then open:

```
http://<mirror-ip>:8080/widgets
```

## What you can do

- **Screen map** — all 13 regions in their real nested arrangement (`top_bar` and `bottom_bar`
  both own a container *and* nest three sub-regions, so the map nests too). Drag a widget between
  regions to change its `position`; drag within a region to reorder.
- **Add and remove** — every module found on disk that is not in your config yet is offered as a
  one-click add. Drag a widget off the screen to park it.
- **Inspector** — a JSON editor per widget with live validation, plus header and position fields.
  The **i** button shows that module's own `defaults` block, read from its source, so you can see
  what is actually configurable without opening the file.
- **Live hide/show** — takes effect immediately, changes no config.
- **Enable/disable** — sets `disabled: true`; settings are preserved.
- **Per-widget scale** — `zoom` a widget up or down to fit the space it has.
- **Region flow** — lay a region out in a row instead of a column, so two narrow widgets can sit
  side by side.
- **Liveness** — each widget shows how long since it last redrew. A feed that died an hour ago
  looks identical to a healthy one on the mirror; here it does not.
- **Theme** — flip the mirror between dark and light.
- **Save & apply**, **Revert**, and **Restart** for the one case that needs it.

## Configuration

| Option | Default | What it does |
|---|---|---|
| `showUrl` | `false` | Print the manager's URL on the mirror itself |
| `restartCommand` | *(unset)* | Shell command used by the Restart button. Leave unset to use the bundled `restart.sh`; set it if you run under pm2, systemd or Docker |
| `infrastructure` | `["alert", "MMM-WidgetManager"]` | Modules that never render anything, so the tray does not offer them as "add to screen" |
| `trayHidden` | `[]` | Modules you have dismissed from the tray |
| `theme` | `"dark"` | `"dark"` or `"light"` |
| `sizes` | `{}` | Per-widget zoom, keyed by module name — e.g. `{ "MMM-Foo": 1.5 }` |
| `flows` | `{}` | Regions laid out as rows, keyed by position — e.g. `{ "top_left": "row" }` |
| `alarms` | `[]` | Status chips in the toolbar. Empty means none are shown — see below |

### Status chips (`alarms`)

If you have modules that expose a status route, the toolbar can poll them and show a chip.
Off by default, because a chip for a module you do not have is worse than no chip at all.

```js
alarms: [
    {
        label:   "servers",           // shown on the chip
        status:  "/server/status",    // polled every 5s, must return JSON
        mute:    "/server/mute",      // optional; clicking a ringing chip calls this
        level:   "severity",          // a field already holding "ok" | "warn" | "down"
        ringing: "alarming",          // truthy => the chip pulses
        muted:   "muted",
        text:    { ok: "all clear", warn: "degraded", down: "{n} down" },
        count:   "issues"             // {n} above = this field's value, or array length
    }
]
```

`level` can also be an object of field names tested for truthiness, worst first:
`level: { down: "alarming", warn: "waiting" }`.

Deliberately a handful of field names rather than a templating language: the config is rewritten
as JSON when you save, so functions would not survive the round trip.

## How changes apply

This is the part worth reading if you write MagicMirror modules.

MagicMirror serves `/config` from an object captured at startup (`js/server.js:115`) — it **never
re-reads `config.js`**. So writing the file alone changes nothing on a running mirror, which is
why editing config has traditionally meant a restart.

But `global.config` (`js/app.js:189`) and the object `/config` serves are the **same reference**:
`new Server(configObj)` (`js/app.js:235`) receives the very `configObj` whose `fullConf` was
assigned to `global.config`. So the helper writes the file, updates that object **in place**, and
asks the mirror page to reload. The reload reads the new layout — about 3 seconds, against roughly
20 for a process restart.

**The one exception:** node helpers are instantiated only at boot, and `disabled` entries are
skipped then (`js/app.js:216`). So enabling a module that ships a `node_helper.js` — whether newly
added or un-parked — genuinely needs a restart. The panel detects exactly that case and raises the
restart banner. Nothing else triggers it.

## Theming convention (`--mm-ink`)

The light theme is a variable swap, not a stylesheet of overrides. This module ships
`--mm-ink` — an ink channel for rules, bars and chart strokes — on both `:root` and `.mm-light`.

If you write modules, using `rgb(var(--mm-ink) / 40%)` instead of a hardcoded white makes your
strokes follow the theme instead of vanishing on a light background. It is opt-in and inert if
nothing references it; it is a convention this module offers, not a MagicMirror standard.

## Security

**There is no authentication.** This page can rewrite `config.js` and restart the mirror process,
and it is reachable by anyone who can reach the mirror's web server. It is protected only by
MagicMirror's `ipWhitelist` — the same posture as MagicMirror's own `/config` endpoint.

Do not expose port 8080 to the internet. On a shared network, keep `ipWhitelist` tight.

## Caveats

- **Saving rewrites `config.js` as JSON.** Comments and computed expressions
  (`7 * 24 * 60 * 60 * 1000`) are replaced by their evaluated values. A timestamped
  `config.js.backup-<time>` is written before every save.
- **Live hide/show is not persisted** — it is runtime state. Use the Enabled checkbox and Save if
  you want it to survive a restart.
- **Restart** assumes a plain `electron js/electron.js` launch. Set `restartCommand` otherwise.

## Layout choices that stay yours

This module styles only the classes its own JavaScript applies. Things that are a matter of taste
for a particular screen belong in your `css/custom.css` — for example:

```css
:root {
    --gap-body-top: 8px;    /* the stock theme uses 60px all round */
    --gap-modules: 4px;
}

/* A 4K panel renders px-sized layouts at half their intended physical size. */
@media (min-width: 2560px) { html { zoom: 1.5; } }
```

## Tested against

MagicMirror² 2.37.0, Node 22, on a Raspberry Pi.

## Licence

MIT — see [LICENSE](LICENSE). MagicMirror² itself is MIT, © Michael Teeuw.
