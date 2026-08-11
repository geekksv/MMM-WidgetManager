/*
 * MMM-WidgetManager — mirror side
 *
 * Draws nothing by default. Two jobs:
 *   1. report the live module list back to the node helper, so the panel knows
 *      what is actually on screen;
 *   2. apply layout changes to the running mirror — show/hide, and moving a
 *      module between regions — so the panel feels immediate instead of
 *      requiring a restart for every tweak.
 */

/*
 * The regions that stack widgets in a column and can therefore overflow. The
 * bars are excluded: they are full-width strips that grow sideways.
 */
const FIT_REGIONS = ".region.top.left, .region.top.center, .region.top.right,"
	+ " .region.bottom.left, .region.bottom.center, .region.bottom.right,"
	+ " .region.upper.third, .region.middle.center, .region.lower.third";

Module.register("MMM-WidgetManager", {

	defaults: {
		// Show a small hint on the mirror with the manager URL.
		showUrl: false,
		// Animation speed (ms) used when the panel hides or shows a module.
		animationSpeed: 300,
		// "dark" (default mirror look) or "light" (inverted).
		theme: "dark",
		// Per-widget scale, keyed by module name: { "MMM-Foo": 1.5 }
		sizes: {},
		/*
		 * Regions laid out side by side instead of stacked, keyed by position:
		 * { "top_left": "row" }. MagicMirror stacks every module in a region
		 * vertically, so this is the only way to put one widget beside another
		 * without moving it to a different region — and there are only three
		 * columns per band to move it to.
		 */
		flows: {}
	},

	start () {
		Log.info(`Starting module: ${this.name}`);
		// Created here, not in watchActivity(): report() reads it and runs first.
		this.lastChange = new Map();
		// Apply straight away so a light mirror doesn't flash black on every boot.
		this.applyTheme(this.config.theme);
	},

	/**
	 * Scale a module by name, applying to every instance of it.
	 *
	 * `zoom` scales px and rem alike, so it resizes widgets whose inner box is a
	 * fixed size — a widget whose card is 400x244, say —
	 * without needing to rework their stylesheets. Setting width/height on the
	 * wrapper would enlarge the box but leave the type unchanged.
	 * @param {string} name module name
	 * @param {number} scale multiplier; 1 clears the override
	 */
	applySize (name, scale) {
		for (const m of MM.getModules()) {
			if (m.name !== name) continue;
			const el = document.getElementById(m.identifier);
			if (!el) continue;
			if (!scale || Number(scale) === 1) el.style.removeProperty("zoom");
			else el.style.zoom = Number(scale);
		}
	},

	/**
	 * Lay a region's widgets out side by side, or back into a stack.
	 *
	 * Applied to the region's `.container`, which is the element that actually
	 * holds the modules. `align-items: flex-start` keeps them top-aligned rather
	 * than stretched to the tallest one, and the gap reuses --gap-modules so the
	 * horizontal spacing matches the vertical spacing everywhere else.
	 * @param {string} position region id, e.g. "top_left"
	 * @param {string} dir "row" or "column"
	 */
	applyFlow (position, dir) {
		const box = this.container(position);
		if (!box) return;
		if (dir === "row") {
			box.style.display = "flex";
			box.style.flexDirection = "row";
			box.style.alignItems = "flex-start";
			box.style.gap = "var(--gap-modules)";
			// The stacking margin would double the gap between neighbours.
			box.classList.add("wm-row");
		} else {
			box.style.removeProperty("display");
			box.style.removeProperty("flex-direction");
			box.style.removeProperty("align-items");
			box.style.removeProperty("gap");
			box.classList.remove("wm-row");
		}
		this.scheduleFit();
	},

	/** Apply every configured flow — used at startup so rows survive a restart. */
	applyAllFlows () {
		for (const position of MM.getAvailableModulePositions) {
			this.applyFlow(position, (this.config.flows || {})[position] || "column");
		}
	},

	/** Apply every configured scale — used at startup so sizes survive a restart. */
	applyAllSizes () {
		for (const [name, scale] of Object.entries(this.config.sizes || {})) {
			this.applySize(name, scale);
		}
		this.scheduleFit();
	},

	/**
	 * Shrink a region until everything in it fits on screen.
	 *
	 * A region stacks its widgets in one column and simply runs off the bottom of
	 * the display when they don't fit. That failed silently and badly: with the
	 * chat window at 1.8x it is 1051px tall on a 1080px screen, so a second
	 * widget dropped into top_right vanished completely rather than looking
	 * cramped — nothing on screen suggested it was even there.
	 *
	 * The scale goes on the region's container, not the region itself: the
	 * regions are absolutely positioned by percentage offsets, and zooming those
	 * would move the region as well as resize it.
	 */
	fitRegions () {
		this.fitting = true;

		const vh = document.documentElement.clientHeight;
		const vw = document.documentElement.clientWidth;
		const SAFE = 4;

		/*
		 * Clear every zoom before measuring anything. Measuring one region while
		 * its neighbour is still scaled would read the neighbour's shrunken edge
		 * as the space available, and each pass would compound the last one's.
		 */
		const fits = {};
		const regions = [...document.querySelectorAll(FIT_REGIONS)];
		for (const region of regions) {
			region.querySelector(":scope > .container")?.style.removeProperty("zoom");
		}
		void document.body.offsetWidth;   // force the reflow before reading rects

		for (const region of regions) {
			const box = region.querySelector(":scope > .container");
			if (!box) continue;

			const mods = [...box.querySelectorAll(".module:not(.hidden)")];
			if (!mods.length) continue;

			const r = region.getBoundingClientRect();
			/*
			 * Measured from the modules themselves, not the container's scroll box.
			 * A module whose content is wider than the width it was laid out at
			 * overflows visibly without extending its parent's scrollWidth at all,
			 * so the container reported everything as fitting while a card hung off
			 * the side of the screen. The modules' own rects do see it.
			 */
			const isRow = box.classList.contains("wm-row");
			let needH = box.scrollHeight;
			// A row's width is the sum of its widgets, not the widest one.
			let needW = isRow ? 0 : box.scrollWidth;
			for (const m of mods) {
				const mr = m.getBoundingClientRect();
				needW = isRow ? needW + mr.width : Math.max(needW, mr.width);
				needH = Math.max(needH, mr.bottom - r.top);
			}
			if (isRow && mods.length > 1) needW += (mods.length - 1) * 10;   // the gaps
			// Bottom regions grow upwards, so their room is measured the other way.
			const roomH = (region.classList.contains("bottom") ? r.bottom : vh - r.top) - SAFE;
			const roomW = this.roomAcross(region, r, vw) - SAFE;

			let k = 1;
			if (needH > roomH && roomH > 0) k = Math.min(k, roomH / needH);
			if (needW > roomW && roomW > 0) k = Math.min(k, roomW / needW);

			// Floor it: past this the text is unreadable, and a widget you cannot
			// read is no more useful than one off the bottom of the screen.
			const scale = k < 0.995 ? Math.max(0.45, k) : 1;
			if (scale < 1) box.style.zoom = scale;

			/*
			 * Remember it for the panel. The shrink is deliberate but silent, and
			 * "why is that widget suddenly small" is otherwise unanswerable
			 * without reading this source.
			 */
			const id = [...region.classList].filter((c) => c !== "region").join("_");
			fits[id] = Number(scale.toFixed(3));
		}
		this.fits = fits;
		// The panel is showing stale scales until it hears the new ones.
		if (this.reported) this.report();

		// Let the resulting resize settle before listening again.
		requestAnimationFrame(() => { this.fitting = false; });
	},

	/**
	 * How much horizontal space a region really has.
	 *
	 * Not simply the distance to the screen edge: the left, centre and right
	 * regions of a bar sit side by side, so a wide region runs into its
	 * neighbour long before it reaches the edge. That is exactly what happened
	 * the first time a region was laid out as a row — the clock and the fleet
	 * panel together were 990px wide and drove straight through the chat window,
	 * while this function's predecessor reported 1912px of room.
	 *
	 * Empty neighbours are ignored, so a region is free to use the whole width
	 * when nothing is beside it.
	 * @param {HTMLElement} region the region being measured
	 * @param {DOMRect} r its current rect
	 * @param {number} vw viewport width
	 * @returns {number} the width available to it
	 */
	roomAcross (region, r, vw) {
		const bar = region.parentElement;
		const isRight = region.classList.contains("right");
		const isCenter = region.classList.contains("center");
		if (!bar) return isRight ? r.right : vw - r.left;

		// Neighbours in the same bar that actually hold something.
		const others = [...bar.children].filter((el) => {
			if (el === region || !el.classList?.contains("region")) return false;
			return Boolean(el.querySelector(".module:not(.hidden)"));
		});

		let left = 0;
		let right = vw;
		for (const el of others) {
			const o = el.getBoundingClientRect();
			if (o.right <= r.left + 1) left = Math.max(left, o.right);        // sits to our left
			else if (o.left >= r.right - 1) right = Math.min(right, o.left);  // sits to our right
			else if (isCenter || isRight) left = Math.max(left, o.right);
			else right = Math.min(right, o.left);
		}

		return isRight ? r.right - left : Math.min(right, vw) - r.left;
	},

	/** Coalesce the many events that can change a region's height into one pass. */
	scheduleFit () {
		clearTimeout(this.fitTimer);
		this.fitTimer = setTimeout(() => this.fitRegions(), 200);
	},

	/** Refit whenever a region's contents change size, and on resize. */
	watchRegions () {
		window.addEventListener("resize", () => this.scheduleFit());

		if (typeof ResizeObserver !== "function") return;
		// Guarded against its own output: fitRegions resizes what it observes.
		const obs = new ResizeObserver(() => {
			if (this.fitting) return;
			this.scheduleFit();
		});
		for (const region of document.querySelectorAll(FIT_REGIONS)) {
			const box = region.querySelector(":scope > .container");
			if (box) obs.observe(box);
		}
	},

	/**
	 * Swap the mirror's palette. The class re-declares MagicMirror's four colour
	 * variables plus our ink channel, so every module follows without needing to
	 * know about themes.
	 * @param {string} theme "light" or "dark"
	 */
	applyTheme (theme) {
		/*
		 * On <html>, not <body>: html carries its own
		 * `background: var(--color-background)` (css/main.css:24) and shows
		 * through the body margin, so theming only body left black edges.
		 */
		document.documentElement.classList.toggle("mm-light", theme === "light");
	},

	getStyles () {
		return ["MMM-WidgetManager.css"];
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "wm-hint";
		if (this.config.showUrl) {
			wrapper.innerText = `${location.protocol}//${location.host}/widgets`;
		}
		return wrapper;
	},

	notificationReceived (notification) {
		/*
		 * DOM_OBJECTS_CREATED is broadcast to every module once all DOMs exist, so
		 * the visibility we report is accurate. MODULE_DOM_CREATED is no use here:
		 * this module has no position, and main.js skips DOM creation (and that
		 * notification) for position-less modules.
		 */
		if (notification === "DOM_OBJECTS_CREATED" || notification === "ALL_MODULES_STARTED") {
			this.applyAllSizes();
			this.applyAllFlows();
			this.refreshRegions();

			/*
			 * Watchers attach on DOM_OBJECTS_CREATED only, never on
			 * ALL_MODULES_STARTED. That one fires before any module element
			 * exists, so attaching there observed nothing and — because it set
			 * the guard — stopped the real attempt from ever running. Same trap
			 * as MODULE_DOM_CREATED, which this module already avoids.
			 */
			if (notification === "DOM_OBJECTS_CREATED" && !this.watching) {
				this.watching = true;
				this.watchRegions();
				this.watchActivity();
			}
			this.report();
		}
	},

	/**
	 * Resolve a region name like "top_left" to its container element.
	 * Mirrors selectWrapper() in js/main.js.
	 * @param {string} position region name
	 * @returns {HTMLElement|null} the container element
	 */
	container (position) {
		const parent = document.getElementsByClassName(position.replace("_", " "));
		if (!parent.length) return null;
		const wrapper = parent[0].getElementsByClassName("container");
		return wrapper.length ? wrapper[0] : null;
	},

	/**
	 * Collapse regions with no visible modules and expand those that have some.
	 *
	 * A local copy of updateWrapperStates() from js/main.js, which is private to
	 * that module. Without this, a region emptied by a move keeps its margins and
	 * a newly filled one stays collapsed.
	 */
	refreshRegions () {
		for (const position of MM.getAvailableModulePositions) {
			const wrapper = this.container(position);
			if (!wrapper) continue;
			const wrappers = wrapper.getElementsByClassName("module");
			let visible = false;
			for (const el of wrappers) {
				if (el.style.position === "" || el.style.position === "static") visible = true;
			}
			wrapper.className = visible ? "container" : "container hidden";
		}
		// Every path that reshuffles a region ends up here, so this is the one
		// place a refit has to be triggered from.
		this.scheduleFit();
	},

	/**
	 * Send the current module list and visibility up to the node helper.
	 */
	report () {
		this.reported = true;
		const now = Date.now();
		const state = MM.getModules().map((m) => {
			const el = document.getElementById(m.identifier);
			const seen = this.lastChange.get(m.identifier);
			return {
				identifier: m.identifier,
				name: m.name,
				position: m.data.position || null,
				order: el && el.style.order !== "" ? Number(el.style.order) : (m.data.order || 0),
				header: m.data.header || null,
				hidden: m.hidden === true,
				// Seconds since this widget last redrew. The panel has no other way
				// to tell a widget that is working from one that died quietly hours
				// ago still showing its last good frame.
				idleSecs: seen ? Math.round((now - seen) / 1000) : null
			};
		});
		this.sendSocketNotification("WM_REGISTER", { modules: state, fits: this.fits || {} });
	},

	/**
	 * Watch every widget for redraws, so the panel can show liveness.
	 *
	 * A MutationObserver rather than MagicMirror's notifications: those only fire
	 * for modules that opt into updateDom, and what actually matters is whether
	 * the pixels changed. Every widget here redraws on a timer of some sort, so
	 * silence is a real signal.
	 */
	watchActivity () {
		this.lastChange = this.lastChange || new Map();
		const obs = new MutationObserver((records) => {
			const now = Date.now();
			for (const rec of records) {
				const el = rec.target.closest ? rec.target.closest(".module") : null;
				if (el && el.id) this.lastChange.set(el.id, now);
			}
		});
		for (const m of MM.getModules()) {
			const el = document.getElementById(m.identifier);
			if (!el) continue;
			this.lastChange.set(m.identifier, Date.now());
			obs.observe(el, { childList: true, subtree: true, characterData: true });
		}
		// Push liveness to the panel on a slow beat; it renders the age itself.
		clearInterval(this.reportTimer);
		this.reportTimer = setInterval(() => this.report(), 10000);
	},

	socketNotificationReceived (notification, payload) {
		/*
		 * A save has landed and the helper has already updated the config that
		 * /config serves, so reloading picks it up. Only the mirror acts on this:
		 * the manager page shares this namespace but never registers the handler.
		 */
		if (notification === "WM_RELOAD") {
			setTimeout(() => location.reload(), 400);
			return;
		}

		if (notification === "WM_THEME") {
			this.applyTheme(payload?.theme);
			return;
		}

		if (notification === "WM_FLOW" && payload?.position) {
			this.config.flows = this.config.flows || {};
			if (payload.dir === "row") this.config.flows[payload.position] = "row";
			else delete this.config.flows[payload.position];
			this.applyFlow(payload.position, payload.dir);
			this.report();
			return;
		}

		if (notification === "WM_SIZE" && payload?.name) {
			this.applySize(payload.name, payload.scale);
			// A resized widget changes how full its region is.
			this.refreshRegions();
			this.report();
			return;
		}

		if (notification === "WM_QUERY") {
			this.report();
			return;
		}

		if (notification === "WM_TOGGLE" && payload) {
			const target = MM.getModules().find((m) => m.identifier === payload.identifier);
			if (!target) return;
			const done = () => { this.refreshRegions(); this.report(); };
			if (payload.hidden) {
				target.hide(this.config.animationSpeed, done, { lockString: this.identifier });
			} else {
				target.show(this.config.animationSpeed, done, { lockString: this.identifier });
			}
			return;
		}

		if (notification === "WM_MOVE" && payload) {
			this.move(payload);
		}
	},

	/**
	 * Move a live module into another region and/or change its order, by
	 * re-parenting its DOM node the same way createDomObjects() places it.
	 * @param {object} payload identifier, position and order
	 */
	move (payload) {
		const target = MM.getModules().find((m) => m.identifier === payload.identifier);
		const el = document.getElementById(payload.identifier);
		if (!target || !el) return;

		if (typeof payload.order === "number") {
			el.style.order = payload.order;
		}

		if (payload.position) {
			const dest = this.container(payload.position);
			if (dest) {
				dest.appendChild(el);
				// Keep the module's own view of itself in step with the DOM.
				target.data.position = payload.position;
			}
		}

		this.refreshRegions();
		this.report();
	}
});
