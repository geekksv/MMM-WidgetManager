# Configuration

Every option, all optional. The module works with an empty `config: {}`.

```js
{
    module: "MMM-WidgetManager",
    config: {
        showUrl: false
    }
}
```

---

## Options

| Option | Type | Default | What it does |
|---|---|---|---|
| `showUrl` | boolean | `false` | Print the panel's URL on the mirror itself. Handy while setting up, then turn it off |
| [`restartCommand`](#restartcommand) | string | *(unset)* | Shell command behind the **Restart** button |
| `infrastructure` | string[] | `["alert", "MMM-WidgetManager"]` | Modules that never render anything, so the tray does not offer them as "add to screen" |
| `trayHidden` | string[] | `[]` | Modules you have dismissed from the tray. Managed by the **×** on a tray chip |
| `theme` | string | `"dark"` | `"dark"` or `"light"`. Managed by the toolbar toggle |
| `sizes` | object | `{}` | Per-widget zoom, keyed by module name — `{ "MMM-Foo": 1.5 }` |
| `flows` | object | `{}` | Regions laid out as a row rather than a column — `{ "top_left": "row" }` |
| [`alarms`](#status-chips) | object[] | `[]` | Status chips in the toolbar |

Most of these are written **by** the panel rather than by you: change the theme or scale a widget,
press **Save & apply**, and the value lands in `config.js` on the module's own entry. Editing them
by hand is supported, not required.

---

## `restartCommand`

The **Restart** button runs the bundled `restart.sh`, which assumes a plain
`electron js/electron.js` launch. If a supervisor owns your mirror, tell the module:

```js
restartCommand: "pm2 restart mm"
```

| Supervisor | Value |
|---|---|
| pm2 | `"pm2 restart mm"` |
| systemd | `"sudo systemctl restart magicmirror"` |
| Docker | `"docker restart magicmirror"` |
| npm | `"npm start"` |

When set, `restart.sh` is not consulted at all. A module has no business assuming how its host was
started, so this option always wins.

---

## Status chips

If you run modules that expose a status route, the toolbar can poll them and show a chip — armed
and quiet, degraded, or ringing. **Off by default**: a chip for a module you do not have is worse
than no chip at all.

```js
alarms: [
    {
        label:   "servers",           // shown on the chip
        status:  "/server/status",    // polled every 5s, must return JSON
        mute:    "/server/mute",      // optional — clicking a ringing chip calls this
        sound:   "/server/sound",     // optional — adds a speaker toggle to the chip
        level:   "severity",          // a field already holding "ok" | "warn" | "down"
        ringing: "alarming",          // truthy => the chip pulses
        muted:   "muted",
        text:    { ok: "all clear", warn: "degraded", down: "{n} down" },
        count:   "issues"             // {n} above = this field's value, or its length if an array
    }
]
```

### Fields

| Field | Required | Meaning |
|---|---|---|
| `label` | ✔ | Text on the chip |
| `status` | ✔ | URL polled every 5 seconds; must return JSON |
| `mute` | | URL called when a *ringing* chip is clicked. Omit and the chip is display-only |
| `level` | | How to derive `ok` / `warn` / `down` — see below. Defaults to `ok` |
| `ringing` | | Field name that, when truthy, makes the chip pulse. Default `"alarming"` |
| `muted` | | Field name for the muted state. Default `"muted"` |
| `sound` | | Base URL for a sound toggle. The chip gains a speaker button calling `<sound>/on` and `<sound>/off` |
| `silent` | | Field name for the silenced state. Default `"silent"` |
| `text` | | Chip text per level. `{n}` is replaced by `count` |
| `count` | | Field supplying `{n}`. An array's length is used if it is an array |

### Muting is not silencing

They answer different questions, so the chip offers both.

**Clicking the chip** mutes: it acknowledges the faults present at that moment and
re-arms itself as soon as a new one appears. That is what you want when you have
seen the problem and are dealing with it.

**The speaker button** silences: a standing choice about whether this alarm is
ever audible. Somebody running both a support alarm and a fleet alarm usually
wants to hear one of them and not the other, and mute cannot say that — it would
un-say it on the next fault.

A silenced alarm still shows its colour, its count and its ringing state, and
still reports honestly on its status route. It just makes no noise. The chip dims
slightly and stops pulsing so the difference is visible across the room.

### An unrecognised level reads as "off"

If `level` names a field whose value is not `ok`, `warn` or `down` — a module
that is up but cannot reach the thing it monitors, say — the chip greys out
rather than showing green. A dashboard that reports "fine" when it does not
actually know is worse than one that admits it.

### Two forms of `level`

**A field name**, when your route already returns the level:

```js
level: "severity"          // response: { severity: "warn", ... }
```

**An object of field names**, tested for truthiness worst-first, when it does not:

```js
level: { down: "alarming", warn: "waiting" }
```

### Why field names and not functions

The config is rewritten as JSON when you save, so a function would not survive the round trip.
A templating language with dotted paths and pluralisation was considered and rejected — more
machinery than a toolbar chip is worth. If your route's shape does not fit these fields, it is
usually easier to add a field to the route.

---

## Theming: the `--mm-ink` convention

The light theme is a **variable swap**, not a stylesheet of overrides. MagicMirror's palette is
four CSS variables on `:root` (`css/main.css:2-5`), and this module redefines them under
`html.mm-light`.

It also ships one variable of its own, on both `:root` and `.mm-light`:

```css
--mm-ink: 255 255 255;    /* dark theme */
--mm-ink: 0 0 0;          /* light theme */
```

If you write modules, this is worth adopting. A rule, bar or chart stroke hardcoded to white
**vanishes** on a light background. Written against the variable, it follows the theme:

```css
border-bottom: 1px solid rgb(var(--mm-ink) / 12%);
```

It is opt-in, inert if nothing references it, and a convention this module offers — not a
MagicMirror standard.

---

## Layout choices that stay yours

This module styles only the classes its own JavaScript applies — `mm-light` and `wm-row`. Anything
that is a matter of taste for a particular screen deliberately does **not** ship with it, because
a module should not decide how your mirror is spaced. Those belong in `css/custom.css`:

```css
:root {
    /* The stock theme uses 60px of padding all round. */
    --gap-body-top: 8px;
    --gap-body-right: 8px;
    --gap-body-bottom: 8px;
    --gap-body-left: 8px;

    /* This gap sits inside each module, so a widget scaled to 1.8x multiplies
       it too — 10px reads as 18px on screen. */
    --gap-modules: 4px;
}

/* Everything is sized in px against a 20px root, so a 4K panel would render
   the whole layout at half its intended physical size. `zoom` scales px and
   rem alike, including fixed widget widths, which a root font-size bump
   would not touch. */
@media (min-width: 2560px) { html { zoom: 1.5; } }
@media (min-width: 3400px) { html { zoom: 2; } }

/* A floor for a column, so a widget cannot collapse its region. */
.region.top.left .module { min-width: 380px; }
```

---

## Next

- **[Setup guide](setup.md)** — installing and integrating
- **[How it works](how-it-works.md)** — the live-apply mechanism
- **[Controlling the mirror](controlling-the-mirror.md)** — the `mm` command
