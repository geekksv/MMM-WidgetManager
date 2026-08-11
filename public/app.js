/* MMM-WidgetManager — browser UI */

(function () {
	"use strict";

	// This module manages the screen; it never appears on it.
	const SELF = "MMM-WidgetManager";

	/*
	 * The mirror's real region tree (index.html). top_bar and bottom_bar own a
	 * container AND nest three sub-regions, so the map has to nest too or it
	 * misrepresents where things land.
	 */
	const TREE = [
		{ id: "fullscreen_below" },
		{ id: "top_bar", children: ["top_left", "top_center", "top_right"] },
		{ id: "upper_third" },
		{ id: "middle_center" },
		{ id: "lower_third" },
		{ id: "bottom_bar", children: ["bottom_left", "bottom_center", "bottom_right"] },
		{ id: "fullscreen_above" }
	];

	const ALL_REGIONS = TREE.flatMap((r) => [r.id, ...(r.children || [])]);

	const socket = io("/MMM-WidgetManager");

	let modules = [];       // working copy of config.modules, each with a _uid
	let available = [];     // modules found on disk
	let live = [];          // what the mirror currently has loaded
	let selected = null;    // _uid being inspected
	let dirty = false;      // unsaved config changes
	let restartNeeded = ""; // non-empty => changes that can't apply live
	let dragUid = null;
	let uid = 0;

	/*
	 * Tray filtering. `infrastructure` are modules that never render anything, so
	 * offering them as "add this to the screen" is misleading. `trayHidden` is the
	 * user's own dismissed list. Both live on this module's config entry, so they
	 * persist through the normal save path.
	 */
	let infrastructure = ["alert", "MMM-WidgetManager"];
	/*
	 * Status chips in the toolbar, off unless configured. See `alarms` in the
	 * README — each entry names a status route, a mute route and the fields to
	 * read out of the response.
	 */
	let alarms = [];
	const alarmEls = [];
	let trayHidden = [];
	let showHidden = false;
	let theme = "dark";
	let sizes = {};   // per-widget scale, keyed by module name
	let flows = {};   // regions laid out side by side, keyed by position
	let fits = {};    // auto-fit scale the mirror settled on, keyed by region

	const $ = (id) => document.getElementById(id);
	const placed = (m) => !m.disabled && !!m.position;
	const visible = (m) => m.module !== SELF;

	/* ---------------- state helpers ---------------- */

	function markDirty (on) {
		dirty = on;
		$("save").disabled = !on;
		$("dirty").classList.toggle("hidden", !on);
	}

	function needRestart (why) {
		restartNeeded = why;
		$("banner").classList.toggle("hidden", !why);
		$("bannerText").textContent = why;
	}

	function toast (msg, kind) {
		const el = $("toast");
		el.textContent = msg;
		el.className = `toast ${kind || ""}`;
		clearTimeout(el._t);
		el._t = setTimeout(() => el.classList.add("hidden"), 4500);
	}

	/**
	 * Pair a config entry with the live module instance it produced. Matching is
	 * by name in order of appearance, which is how MagicMirror assigns identifiers.
	 * @param {object} m working-copy entry
	 * @returns {object|null} matching live entry, if the mirror loaded it
	 */
	function liveFor (m) {
		const nth = modules.filter((x) => x.module === m.module && placed(x)).indexOf(m);
		if (nth < 0) return null;
		return live.filter((l) => l.name === m.module)[nth] || null;
	}

	/** @param {string} region region id @returns {Array<object>} its modules, in order */
	function inRegion (region) {
		return modules
			.filter((m) => visible(m) && placed(m) && m.position === region)
			.sort((a, b) => (a.order || 0) - (b.order || 0));
	}

	/** @param {string} name module name @returns {boolean} whether the tray should skip it */
	function trayFiltered (name) {
		if (infrastructure.includes(name)) return true;      // renders nothing, ever
		if (!showHidden && trayHidden.includes(name)) return true;
		return false;
	}

	/** @returns {Array<object>} everything not on the screen right now, minus what's filtered */
	function trayItems () {
		const parked = modules.filter((m) => visible(m) && !placed(m));
		const inConfig = new Set(modules.map((m) => m.module));
		const fresh = available
			.filter((a) => a.name !== SELF && !inConfig.has(a.name))
			.map((a) => ({ _fresh: true, module: a.name, builtin: a.builtin }));
		return [...parked, ...fresh]
			.filter((m) => !trayFiltered(m.module))
			.sort((a, b) => a.module.localeCompare(b.module));
	}

	/**
	 * Persist the tray-hidden list onto this module's own config entry, then save.
	 * @param {string} name module to dismiss from the tray
	 */
	function dismissFromTray (name) {
		if (!trayHidden.includes(name)) trayHidden.push(name);
		syncTrayHidden();
	}

	/** @param {string} name module to put back in the tray */
	function restoreToTray (name) {
		trayHidden = trayHidden.filter((n) => n !== name);
		syncTrayHidden();
	}

	/** Write the list onto this module's own config entry so a save persists it. */
	function syncTrayHidden () {
		const self = modules.find((m) => m.module === SELF);
		if (self) {
			self.config = self.config || {};
			self.config.trayHidden = [...trayHidden];
		}
		markDirty(true);
		render();
	}

	/** Renumber a region's `order` values to 0..n-1 and push any change to the mirror. */
	function normalise (region) {
		inRegion(region).forEach((m, i) => {
			if (m.order !== i) {
				m.order = i;
				const l = liveFor(m);
				if (l) socket.emit("WM_MOVE", { identifier: l.identifier, position: region, order: i });
			}
		});
	}

	/* ---------------- chips ---------------- */

	function chip (m, inTray) {
		const el = document.createElement("div");
		el.className = "chip";
		if (inTray) el.classList.add("tray-chip");
		if (m._fresh) el.classList.add("fresh");
		if (m._uid && m._uid === selected) el.classList.add("sel");
		el.draggable = true;

		const l = m._fresh ? null : liveFor(m);
		const dot = document.createElement("span");
		dot.className = "dot";
		if (m._fresh) dot.classList.add("new");
		else if (!placed(m)) dot.classList.add("off");
		else if (l && l.hidden) dot.classList.add("hid");
		el.appendChild(dot);

		const nm = document.createElement("span");
		nm.className = "nm";
		nm.textContent = m.module;
		el.appendChild(nm);

		if (inTray) {
			const tag = document.createElement("span");
			tag.className = "tag";
			tag.textContent = m._fresh ? (m.builtin ? "built-in" : "installed") : "settings kept";
			el.appendChild(tag);

			const isHidden = trayHidden.includes(m.module);
			const x = document.createElement("button");
			x.className = "xbtn";
			x.textContent = isHidden ? "↩" : "×";
			x.title = isHidden
				? `Put ${m.module} back in the list`
				: `Remove ${m.module} from this list`;
			x.onclick = (ev) => {
				ev.stopPropagation();
				if (isHidden) restoreToTray(m.module);
				else dismissFromTray(m.module);
			};
			el.appendChild(x);
		} else if (l) {
			/*
			 * How long since this widget last redrew. The panel otherwise shows
			 * only what is *configured*, never whether it is *working* — a feed
			 * that died an hour ago looks identical to a healthy one, still
			 * displaying its last good frame.
			 */
			if (typeof l.idleSecs === "number") {
				const age = document.createElement("span");
				const stale = l.idleSecs > 300;
				age.className = `pulse ${stale ? "stale" : ""}`;
				age.textContent = l.idleSecs < 60
					? `${l.idleSecs}s`
					: `${Math.floor(l.idleSecs / 60)}m`;
				age.title = stale
					? `No redraw for ${Math.floor(l.idleSecs / 60)} minutes — this widget may be stuck`
					: "Time since this widget last redrew";
				el.appendChild(age);
			}

			// Live visibility toggle — instant, and not a config change.
			const eye = document.createElement("button");
			eye.className = "eye";
			eye.textContent = l.hidden ? "show" : "hide";
			eye.title = "Show/hide on the mirror right now (not saved)";
			eye.onclick = (ev) => {
				ev.stopPropagation();
				socket.emit("WM_TOGGLE", { identifier: l.identifier, hidden: !l.hidden });
			};
			el.appendChild(eye);
		}

		el.onclick = () => {
			if (m._fresh) return;
			selected = m._uid;
			render();
		};

		el.ondragstart = (ev) => {
			// Fresh tray items are materialised into the config on first drop.
			if (m._fresh) {
				const created = { _uid: ++uid, module: m.module, config: {} };
				modules.push(created);
				dragUid = created._uid;
			} else {
				dragUid = m._uid;
			}
			ev.dataTransfer.effectAllowed = "move";
			ev.dataTransfer.setData("text/plain", m.module);
			el.classList.add("dragging");
		};
		el.ondragend = () => {
			el.classList.remove("dragging");
			dragUid = null;
			render();   // pick up anything that arrived while the drag was in flight
		};

		return el;
	}

	/* ---------------- drop handling ---------------- */

	/**
	 * Work out where in a region the pointer is hovering, so dropping between two
	 * chips inserts there rather than always appending.
	 * @param {HTMLElement} zone the region's drop area
	 * @param {number} y pointer clientY
	 * @returns {number} insertion index
	 */
	function dropIndex (zone, y) {
		const chips = [...zone.querySelectorAll(".chip")];
		for (let i = 0; i < chips.length; i++) {
			const box = chips[i].getBoundingClientRect();
			if (y < box.top + box.height / 2) return i;
		}
		return chips.length;
	}

	function wireRegionDrop (zone, region) {
		zone.ondragover = (ev) => { ev.preventDefault(); zone.classList.add("drop"); };
		zone.ondragleave = () => zone.classList.remove("drop");
		zone.ondrop = (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			zone.classList.remove("drop");
			const m = modules.find((x) => x._uid === dragUid);
			if (!m) return;

			const wasLive = liveFor(m);
			const from = placed(m) ? m.position : null;
			const idx = dropIndex(zone, ev.clientY);

			delete m.disabled;
			m.position = region;
			// Nudge into place, then normalise both regions to clean integers.
			m.order = idx - 0.5;

			if (from && from !== region) normalise(from);
			normalise(region);

			// Preview the move instantly when the module is on the mirror; either
			// way Save is what makes it real.
			if (wasLive) {
				socket.emit("WM_MOVE", { identifier: wasLive.identifier, position: region, order: m.order });
				if (wasLive.hidden) socket.emit("WM_TOGGLE", { identifier: wasLive.identifier, hidden: false });
			}

			selected = m._uid;
			markDirty(true);
			render();
		};
	}

	function wireTrayDrop (zone) {
		zone.ondragover = (ev) => { ev.preventDefault(); zone.classList.add("drop"); };
		zone.ondragleave = () => zone.classList.remove("drop");
		zone.ondrop = (ev) => {
			ev.preventDefault();
			zone.classList.remove("drop");
			const m = modules.find((x) => x._uid === dragUid);
			if (!m) return;

			const from = m.position;
			const l = liveFor(m);
			// Park: keep position and settings, just mark it disabled.
			m.disabled = true;
			if (l) socket.emit("WM_TOGGLE", { identifier: l.identifier, hidden: true });
			if (from) normalise(from);

			markDirty(true);
			render();
		};
	}

	/* ---------------- rendering ---------------- */

	function regionBox (r) {
		const box = document.createElement("div");
		box.className = `region r-${r.id}`;

		const lab = document.createElement("div");
		lab.className = "label";
		lab.textContent = r.id.replace(/_/g, " ");

		/*
		 * Stack or row. MagicMirror puts every widget in a region into one
		 * vertical column, so without this the only way to get two widgets side
		 * by side is to move one into a different region — and there are just
		 * three columns per band. Flipping this lays the region out horizontally,
		 * and "order" then reads left-to-right instead of top-to-bottom.
		 */
		const isRow = flows[r.id] === "row";
		const flip = document.createElement("button");
		flip.className = `flow ${isRow ? "on" : ""}`;
		flip.type = "button";
		flip.textContent = isRow ? "row" : "stack";
		flip.title = isRow
			? "Widgets sit side by side — click to stack them"
			: "Widgets stack vertically — click to place them side by side";
		flip.onclick = (e) => {
			e.stopPropagation();
			const next = isRow ? "column" : "row";
			if (next === "row") flows[r.id] = "row"; else delete flows[r.id];
			socket.emit("WM_FLOW", { position: r.id, dir: next });

			// Ride along on this module's own config entry, so Save persists it.
			const self = modules.find((x) => x.module === SELF);
			if (self) {
				self.config = self.config || {};
				self.config.flows = { ...flows };
			}
			markDirty(true);
			render();
		};
		/*
		 * The auto-fit silently shrinks a region whose contents don't fit. That
		 * is the right behaviour but an invisible one — "why is that widget
		 * suddenly small" had no answer anywhere in the UI.
		 */
		const fit = fits[r.id];
		if (typeof fit === "number" && fit < 0.995) {
			const badge = document.createElement("span");
			badge.className = "fitbadge";
			badge.textContent = `${Math.round(fit * 100)}%`;
			badge.title = "Too much for this region — the mirror is scaling it down to fit."
				+ " Shrink a widget or move one elsewhere to get back to 100%.";
			lab.appendChild(badge);
		}

		lab.appendChild(flip);
		box.appendChild(lab);

		const slot = document.createElement("div");
		slot.className = `slot ${isRow ? "slot-row" : ""}`;
		inRegion(r.id).forEach((m) => slot.appendChild(chip(m, false)));
		wireRegionDrop(slot, r.id);
		box.appendChild(slot);

		if (r.children) {
			const kids = document.createElement("div");
			kids.className = "kids";
			r.children.forEach((c) => kids.appendChild(regionBox({ id: c })));
			box.appendChild(kids);
		}
		return box;
	}

	function renderScreen () {
		const mirror = $("mirror");
		mirror.textContent = "";
		TREE.forEach((r) => mirror.appendChild(regionBox(r)));
	}

	function renderTray () {
		const tray = $("tray");
		tray.textContent = "";
		const items = trayItems();
		if (!items.length) {
			const e = document.createElement("div");
			e.className = "empty";
			e.textContent = showHidden
				? "Nothing hidden"
				: "Nothing left to add — every widget is already on the screen";
			tray.appendChild(e);
		}
		items.forEach((m) => tray.appendChild(chip(m, true)));
		wireTrayDrop(tray);

		// "n hidden · show / hide" toggle
		const link = $("hiddenLink");
		if (!trayHidden.length) {
			link.classList.add("hidden");
		} else {
			link.classList.remove("hidden");
			link.textContent = showHidden
				? "done"
				: `${trayHidden.length} hidden · show`;
		}
	}

	function field (labelText, control, helpHtml) {
		const f = document.createElement("div");
		f.className = "field";
		const l = document.createElement("label");
		l.textContent = labelText;

		// An optional "i" beside the label, opening the same popover the toolbar
		// help uses.
		if (helpHtml) {
			const help = document.createElement("span");
			help.className = "help help-inline";
			const btn = document.createElement("button");
			btn.className = "info sm";
			btn.type = "button";
			btn.textContent = "i";
			btn.setAttribute("aria-label", `About ${labelText}`);
			const card = document.createElement("div");
			card.className = "helpcard";
			card.setAttribute("role", "tooltip");
			card.innerHTML = helpHtml;
			help.append(btn, card);
			l.appendChild(help);
		}

		f.append(l, control);
		return f;
	}

	/*
	 * What goes in the Config JSON box. Written out because the options are a
	 * per-module thing with no discoverable list in the UI — without this the
	 * only way to learn them is to read each module's source.
	 */
	const CONFIG_HELP = `
		<div class="hc-title">Config parameters</div>
		<p class="hc-note">
			Every option this widget accepts, as JSON. Keys are the parameter names,
			values are what you want them set to. Anything you leave out keeps the
			widget's own default — you only list what you're changing.
		</p>
		<p class="hc-note"><strong>To add one:</strong> put it inside the braces as
			<code>"name": value</code>, with a comma between entries. Strings need
			quotes, numbers and true/false do not.</p>
		<pre class="hc-code">{
  "title": "Web Analytics",
  "rotateInterval": 8000,
  "topCountries": 5
}</pre>
		<p class="hc-note"><strong>Where the names come from:</strong> each widget's
			<code>defaults</code> block lists every parameter it understands —
			<code>modules/&lt;widget&gt;/&lt;widget&gt;.js</code> on the Pi, or the
			README for widgets from GitHub. A name that isn't in <code>defaults</code>
			is simply ignored.</p>
		<p class="hc-note hc-foot">
			Times are milliseconds (8000 = 8s). Never put API keys or tokens here —
			this page is served over your network, so keys belong in a file and are
			referenced by path, the way <code>keyFile</code> and
			<code>tokenFile</code> already do. The box turns red on invalid JSON and
			Save stays blocked until it parses.
		</p>`;

	/*
	 * Float every "i" popover above the page.
	 *
	 * They used to be absolutely positioned inside their button, which put them
	 * at the mercy of every ancestor: the tray is sticky at z-index 20 and the
	 * inspector is sticky too (which makes its own stacking context), so a card
	 * opened down there rendered *behind* the tray instead of over it. Fixed
	 * positioning, placed from the button's own rect, escapes all of that — and
	 * clamping to the viewport keeps a card near the right edge on screen.
	 * @param {ParentNode} root subtree to wire up
	 */
	let hcSeq = 0;
	const paramCache = new Map();

	/** @param {string} s text @returns {string} it, safe to drop into innerHTML */
	function esc (s) {
		return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
	}

	/**
	 * Fill a popover with the parameters a widget actually accepts.
	 *
	 * @param {string} name module name
	 * @param {HTMLElement} card the popover to fill
	 */
	async function loadParams (name, card) {
		let data = paramCache.get(name);
		if (!data) {
			try {
				data = await (await fetch(`/widgets/params/${encodeURIComponent(name)}`)).json();
			} catch (e) {
				data = { ok: false, error: e.message };
			}
			paramCache.set(name, data);
		}

		const head = `<div class="hc-title">${esc(name)} parameters</div>`;
		const howto = `<p class="hc-note hc-foot">Set any of these in <strong>Config JSON</strong> below as
			<code>"name": value</code>, commas between entries, quotes on strings. Leave one out and
			its default applies. Times are milliseconds. Never put API keys here — this page is
			served over your network, so keys go in a file and are referenced by path
			(<code>keyFile</code>, <code>tokenFile</code>).</p>`;

		// Never invent a list: if the source couldn't be read, say so and point at
		// where the real answer lives.
		if (!data.ok) {
			card.innerHTML = `${head}<p class="hc-note">Couldn't read this widget's parameters
				${data.error ? `(${esc(data.error)})` : ""}. Check the widget's README, or its
				<code>defaults</code> block in its own <code>.js</code> file.</p>${howto}`;
			return;
		}

		const rows = data.params.map((p) => `<dt>${esc(p.key)}</dt><dd>${esc(p.note || "—")}
			<span class="hc-def">${esc(p.value)}</span></dd>`).join("");

		card.innerHTML = `${head}
			<p class="hc-note">${data.params.length} parameters, read from
				<code>${esc(data.source)}</code>. The value on the right is the default.</p>
			<dl class="hc-list hc-params">${rows}</dl>${howto}`;
	}

	function wireHelp (root) {
		for (const help of root.querySelectorAll(".help")) {
			if (help.dataset.wired) continue;
			help.dataset.wired = "1";

			const btn = help.querySelector(".info");
			const card = help.querySelector(".helpcard");
			if (!btn || !card) continue;

			// The card is reparented to <body> while open, so the link back to its
			// button has to survive that move.
			if (!card.id) card.id = `hc-${++hcSeq}`;
			help.dataset.cardId = card.id;

			const open = () => {
				/*
				 * Move the card to <body> while it is open.
				 *
				 * `position: fixed` and a big z-index are not enough on their own:
				 * any ancestor with transform, filter, backdrop-filter, contain or
				 * will-change becomes the containing block for fixed children AND
				 * clips them — and the tray already uses backdrop-filter, while both
				 * the tray and the inspector are sticky (each its own stacking
				 * context). Reparenting to <body> removes every ancestor from the
				 * question, which no z-index can guarantee by itself.
				 */
				if (card.parentNode !== document.body) document.body.appendChild(card);
				card.classList.add("open");
				const b = btn.getBoundingClientRect();
				const w = card.offsetWidth;
				const h = card.offsetHeight;
				const left = Math.max(10, Math.min(window.innerWidth - w - 10, b.right - w));
				// Flip above the button when there isn't room beneath it.
				const below = b.bottom + 9;
				const top = below + h > window.innerHeight - 10
					? Math.max(10, b.top - h - 9)
					: below;
				card.style.left = `${left}px`;
				card.style.top = `${top}px`;
			};
			const close = () => {
				if (help.dataset.pinned) return;
				card.classList.remove("open");
				// Hand it back to its button, so a rebuilt inspector takes its
				// cards with it instead of orphaning them in <body>.
				if (card.parentNode === document.body) help.appendChild(card);
			};

			help.addEventListener("mouseenter", open);
			help.addEventListener("mouseleave", close);
			// The card is no longer a descendant of .help while open, so it needs
			// to hold itself open — otherwise it vanishes as the pointer reaches it.
			card.addEventListener("mouseenter", () => card.classList.add("open"));
			card.addEventListener("mouseleave", close);
			btn.addEventListener("focus", open);
			// A click pins it open, so it can be read without holding the pointer
			// still — which is the whole point on a touchscreen.
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				if (help.dataset.pinned) {
					delete help.dataset.pinned;
					card.classList.remove("open");
				} else {
					help.dataset.pinned = "1";
					open();
				}
			});
		}
	}

	/**
	 * Close every pinned card, returning any that were portaled to <body>.
	 * @param {EventTarget|null} except don't close the card containing this node
	 */
	function closeHelp (except) {
		for (const help of document.querySelectorAll(".help[data-pinned]")) {
			// An open card lives in <body>, not under .help, so both have to be
			// checked before deciding a click landed outside it.
			const card = help.dataset.cardId
				? document.getElementById(help.dataset.cardId)
				: help.querySelector(".helpcard");
			if (except && (help.contains(except) || card?.contains(except))) continue;
			delete help.dataset.pinned;
			card?.classList.remove("open");
			if (card && card.parentNode === document.body) help.appendChild(card);
		}
	}

	// One global dismissal path for pinned cards.
	document.addEventListener("click", (e) => closeHelp(e.target));
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closeHelp(null);
	});

	function renderInspector () {
		const box = $("inspector");
		box.textContent = "";
		const m = modules.find((x) => x._uid === selected);

		if (!m) {
			const p = document.createElement("p");
			p.className = "muted pad";
			p.textContent = "Select a widget to edit it.";
			box.appendChild(p);
			return;
		}

		const t = document.createElement("div");
		t.className = "title";
		t.textContent = m.module;

		/*
		 * Per-widget parameter reference. The list is fetched rather than
		 * hardcoded — the helper reads it out of the widget's own `defaults`
		 * block, so it stays true as widgets change and covers ones added later.
		 */
		const phelp = document.createElement("span");
		phelp.className = "help help-inline";
		const pbtn = document.createElement("button");
		pbtn.className = "info sm";
		pbtn.type = "button";
		pbtn.setAttribute("aria-label", `Parameters for ${m.module}`);
		pbtn.textContent = "i";
		const pcard = document.createElement("div");
		pcard.className = "helpcard";
		pcard.setAttribute("role", "tooltip");
		pcard.innerHTML = `<div class="hc-title">${m.module} parameters</div>`
			+ `<p class="hc-note">Loading…</p>`;
		phelp.append(pbtn, pcard);
		t.appendChild(phelp);
		box.appendChild(t);

		loadParams(m.module, pcard);

		const l = liveFor(m);
		const sub = document.createElement("div");
		sub.className = "sub";
		sub.textContent = l ? `live · ${l.identifier}` : "not loaded on the mirror";
		box.appendChild(sub);

		// On screen / parked
		const row = document.createElement("div");
		row.className = "field row";
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.id = "f_on";
		cb.checked = placed(m);
		cb.onchange = () => {
			if (cb.checked) {
				delete m.disabled;
				if (!m.position) m.position = "top_left";
			} else {
				m.disabled = true;
				const cur = liveFor(m);
				if (cur) socket.emit("WM_TOGGLE", { identifier: cur.identifier, hidden: true });
			}
			markDirty(true);
			render();
		};
		const cl = document.createElement("label");
		cl.htmlFor = "f_on";
		cl.textContent = "On screen";
		row.append(cb, cl);
		box.appendChild(row);

		// Position
		const ps = document.createElement("select");
		for (const r of ALL_REGIONS) {
			const o = document.createElement("option");
			o.value = r;
			o.textContent = r;
			ps.appendChild(o);
		}
		ps.value = m.position || "top_left";
		ps.onchange = () => {
			const from = m.position;
			m.position = ps.value;
			delete m.disabled;
			if (from) normalise(from);
			normalise(ps.value);
			const cur = liveFor(m);
			if (cur) socket.emit("WM_MOVE", { identifier: cur.identifier, position: ps.value, order: m.order || 0 });
			markDirty(true);
			render();
		};
		box.appendChild(field("Position", ps));

		// Order
		const ord = document.createElement("input");
		ord.type = "number";
		ord.value = m.order || 0;
		ord.onchange = () => {
			m.order = Number(ord.value) || 0;
			const cur = liveFor(m);
			if (cur) socket.emit("WM_MOVE", { identifier: cur.identifier, position: m.position, order: m.order });
			markDirty(true);
			render();
		};
		box.appendChild(field("Order within region", ord));

		// Size (scale). Applies live; Save makes it stick.
		const sz = document.createElement("input");
		sz.type = "number";
		sz.step = "0.25";
		sz.min = "0.5";
		sz.max = "4";
		sz.value = sizes[m.module] || 1;
		sz.onchange = () => {
			const scale = Math.min(4, Math.max(0.5, Number(sz.value) || 1));
			sz.value = scale;
			if (scale === 1) delete sizes[m.module];
			else sizes[m.module] = scale;

			socket.emit("WM_SIZE", { name: m.module, scale });

			const self = modules.find((x) => x.module === SELF);
			if (self) {
				self.config = self.config || {};
				self.config.sizes = { ...sizes };
			}
			markDirty(true);
		};
		box.appendChild(field("Size (1 = normal, 2 = double)", sz));

		// Header
		const hi = document.createElement("input");
		hi.type = "text";
		hi.value = m.header || "";
		hi.placeholder = "shown above the widget";
		hi.oninput = () => {
			if (hi.value.trim()) m.header = hi.value;
			else delete m.header;
			markDirty(true);
		};
		box.appendChild(field("Header", hi));

		// Config JSON
		const ta = document.createElement("textarea");
		ta.spellcheck = false;
		ta.value = JSON.stringify(m.config || {}, null, 2);
		const err = document.createElement("div");
		err.className = "err";
		ta.oninput = () => {
			try {
				const parsed = JSON.parse(ta.value || "{}");
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					throw new Error("config must be a JSON object");
				}
				m.config = parsed;
				ta.classList.remove("bad");
				err.textContent = "";
				markDirty(true);
			} catch (e) {
				ta.classList.add("bad");
				err.textContent = e.message;
			}
		};
		const cf = field("Config JSON", ta, CONFIG_HELP);
		cf.appendChild(err);
		box.appendChild(cf);

		const sep = document.createElement("div");
		sep.className = "sep";
		box.appendChild(sep);

		const rm = document.createElement("button");
		rm.className = "btn rm";
		rm.textContent = "Delete from config";
		rm.title = "Removes the widget and its settings entirely";
		rm.onclick = () => {
			if (!confirm(`Delete ${m.module} and its settings from config.js?`)) return;
			const cur = liveFor(m);
			if (cur) socket.emit("WM_TOGGLE", { identifier: cur.identifier, hidden: true });
			modules = modules.filter((x) => x._uid !== m._uid);
			selected = null;
			markDirty(true);
			render();
		};
		box.appendChild(rm);
		wireHelp(box);
	}

	function render () {
		renderTray();
		renderScreen();
		renderInspector();
	}

	/* ---------------- socket wiring ---------------- */

	function setConn (state, label) {
		const el = $("conn");
		el.className = `conn ${state}`;
		el.querySelector("span").textContent = label;
	}

	socket.on("connect", () => {
		setConn("up", "connected");
		socket.emit("WM_GET_STATE", {});
	});

	socket.on("disconnect", () => setConn("down", "disconnected"));
	socket.on("connect_error", () => setConn("down", "no connection"));

	socket.on("WM_STATE", (s) => {
		if (s.error) { toast(`Could not read config.js: ${s.error}`, "bad"); return; }
		if (dirty) { live = s.live || []; render(); return; }  // don't clobber edits

		modules = (s.config.modules || []).map((m) => Object.assign({ _uid: ++uid }, m));
		available = s.available || [];
		live = s.live || [];

		// Tray preferences ride along on this module's own config entry.
		const selfCfg = (s.config.modules || []).find((m) => m.module === SELF)?.config || {};
		if (Array.isArray(selfCfg.infrastructure)) infrastructure = selfCfg.infrastructure;
		/*
		 * Rebuilt from config rather than at load: the state arrives over the
		 * socket after this file runs, so building the strip up front would
		 * always see an empty list.
		 */
		if (JSON.stringify(selfCfg.alarms || []) !== JSON.stringify(alarms)) {
			alarms = Array.isArray(selfCfg.alarms) ? selfCfg.alarms : [];
			buildAlarms();
		}
		trayHidden = Array.isArray(selfCfg.trayHidden) ? [...selfCfg.trayHidden] : [];
		showHidden = false;
		theme = selfCfg.theme === "light" ? "light" : "dark";
		sizes = (selfCfg.sizes && typeof selfCfg.sizes === "object") ? { ...selfCfg.sizes } : {};
		flows = (selfCfg.flows && typeof selfCfg.flows === "object") ? { ...selfCfg.flows } : {};
		paintTheme();
		$("meta").textContent = `MagicMirror ${s.version}`;
		markDirty(false);
		render();
	});

	socket.on("WM_LIVE_STATE", (msg) => {
		const l = Array.isArray(msg) ? msg : (msg && msg.live);
		if (msg && !Array.isArray(msg) && msg.fits) fits = msg.fits;
		live = l || [];
		// A re-render mid-drag destroys the element being dragged.
		if (dragUid !== null) return;
		render();
	});

	socket.on("WM_SAVED", (r) => {
		if (!r.ok) { toast(`Save failed: ${r.error}`, "bad"); return; }

		markDirty(false);
		if (r.needsRestart) {
			needRestart(r.needsRestart);
			toast(`Saved. Backup: ${r.backup}`, "good");
		} else {
			needRestart("");
			toast("Saved and applied — the mirror is updating.", "good");
			// Let the mirror reload, then re-sync so panel and mirror agree.
			setTimeout(() => socket.emit("WM_GET_STATE", {}), 3500);
		}
	});

	socket.on("WM_RESTARTING", () => toast("Restarting — this page will reconnect shortly.", ""));

	/* ---------------- toolbar ---------------- */

	function save () {
		/*
		 * Start from a copy of the whole entry so properties this panel doesn't
		 * manage — classes, animateIn, hiddenOnStartup, and anything a module
		 * defines for itself — survive a save. Rebuilding the object from a known
		 * list of fields silently discarded them.
		 */
		const clean = modules.map((m) => {
			const o = { ...m };
			delete o._uid;
			delete o._fresh;
			delete o.builtin;

			o.module = m.module;
			if (m.position) o.position = m.position; else delete o.position;
			if (typeof m.order === "number") o.order = Math.round(m.order); else delete o.order;
			if (m.header) o.header = m.header; else delete o.header;
			if (m.disabled) o.disabled = true; else delete o.disabled;
			if (m.config && Object.keys(m.config).length) o.config = m.config; else delete o.config;
			return o;
		});
		socket.emit("WM_SAVE", { modules: clean });
	}

	$("save").onclick = save;

	$("hiddenLink").onclick = () => {
		showHidden = !showHidden;
		render();
	};

	function paintTheme () {
		const light = theme === "light";
		$("theme").setAttribute("aria-checked", String(light));
		$("themeLabel").textContent = light ? "light" : "dark";
	}

	/**
	 * Poll one configured status route and paint its chip.
	 *
	 * Over HTTP rather than a socket namespace, so the panel never depends on
	 * any particular module being installed. A chip stays visible when quiet:
	 * "armed and silent" and "not working at all" must not look the same.
	 * @param {HTMLElement} el the chip
	 * @param {object} spec the configured alarm
	 */
	async function pollOneAlarm (el, spec) {
		let view;
		try {
			const r = await fetch(spec.status);
			if (!r.ok) throw new Error("no route");
			view = readAlarm(await r.json(), spec);
		} catch {
			// Module not installed, or the mirror is restarting.
			view = { level: "off", text: "n/a" };
		}
		el.className = `alarm a-${view.level}${view.alarming ? " ringing" : ""}`;
		el.querySelector(".alstate").textContent = view.text;
		el.title = view.alarming
			? "Sounding now — click to mute"
			: (view.muted ? "Muted; re-arms on the next new fault" : "Armed and quiet");
	}

	/**
	 * Turn a status payload into a chip, using field names from config.
	 *
	 * Deliberately a handful of field names rather than a templating language:
	 * the mapping has to survive a round trip through config.js, which the helper
	 * rewrites as JSON, so functions are not an option — and a mini-language with
	 * dotted paths and pluralisation would be more machinery than two chips are
	 * worth. `level` is either the name of a field already holding ok/warn/down,
	 * or an object of field names tested for truthiness, worst first.
	 * @param {object} s the status payload
	 * @param {object} spec the configured alarm
	 * @returns {object} {level, text, alarming, muted}
	 */
	function readAlarm (s, spec) {
		let level = "ok";
		if (typeof spec.level === "string") {
			level = ["down", "warn", "ok"].includes(s[spec.level]) ? s[spec.level] : "ok";
		} else if (spec.level) {
			if (s[spec.level.down]) level = "down";
			else if (s[spec.level.warn]) level = "warn";
		}
		const count = spec.count ? (Array.isArray(s[spec.count]) ? s[spec.count].length : s[spec.count]) : 0;
		const text = (spec.text || {})[level];
		return {
			level,
			text: text ? String(text).replace("{n}", count) : level,
			alarming: Boolean(s[spec.ringing || "alarming"]),
			muted: Boolean(s[spec.muted || "muted"])
		};
	}

	/*
	 * Build the strip from config. No alarms configured — the default — leaves the
	 * container empty, so a mirror without these routes shows nothing at all
	 * rather than chips reading "n/a" forever.
	 */
	function buildAlarms () {
		const box = $("alarms");
		box.textContent = "";
		alarmEls.length = 0;
		for (const spec of alarms) {
			const el = document.createElement("span");
			el.className = "alarm";
			el.title = spec.label || spec.id || "";
			el.innerHTML = `<i></i><b></b><span class="alstate">—</span>`;
			el.querySelector("b").textContent = spec.label || spec.id || "alarm";
			// Clicking a ringing alarm mutes it; clicking a quiet one does nothing.
			if (spec.mute) {
				el.onclick = async () => {
					if (!el.classList.contains("ringing")) return;
					await fetch(spec.mute).catch(() => {});
					toast("Muted — re-arms on the next new fault.", "");
					pollAlarms();
				};
			}
			box.appendChild(el);
			alarmEls.push([el, spec]);
		}
	}

	function pollAlarms () {
		for (const [el, spec] of alarmEls) pollOneAlarm(el, spec);
	}

	// One timer for the life of the page; it does nothing until a config with
	// alarms in it arrives and buildAlarms() fills the list.
	setInterval(pollAlarms, 5000);

	$("theme").onclick = () => {
		theme = theme === "light" ? "dark" : "light";
		paintTheme();

		// Apply to the mirror at once, and stage it on this module's own config
		// entry so Save makes it survive a restart.
		socket.emit("WM_THEME", { theme });
		const self = modules.find((m) => m.module === SELF);
		if (self) {
			self.config = self.config || {};
			self.config.theme = theme;
			markDirty(true);
		}
	};

	$("reload").onclick = () => {
		markDirty(false);
		needRestart("");
		socket.emit("WM_GET_STATE", {});
		toast("Reloaded from config.js", "");
	};

	const doRestart = () => {
		if (dirty && !confirm("You have unsaved changes that will be lost. Restart anyway?")) return;
		socket.emit("WM_RESTART", {});
	};
	$("restart").onclick = doRestart;
	$("bannerRestart").onclick = () => {
		if (dirty) save();
		setTimeout(() => socket.emit("WM_RESTART", {}), 400);
	};

	window.addEventListener("beforeunload", (e) => {
		if (dirty) { e.preventDefault(); e.returnValue = ""; }
	});

	// The toolbar's help lives in the static markup, so wire it once at startup.
	wireHelp(document);
})();
