/*
 * MMM-WidgetManager — server side
 *
 * Owns everything that has to touch the filesystem or the running process:
 * discovering installed modules, reading and rewriting config.js, and
 * restarting the mirror. The browser UI talks to this over the module's
 * socket.io namespace; the mirror's own frontend instance listens on the same
 * namespace for live show/hide.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const NodeHelper = require("node_helper");
const Log = require("logger");

// Must match the regions declared in MagicMirror's index.html.
const REGIONS = [
	"top_bar", "top_left", "top_center", "top_right",
	"upper_third", "middle_center", "lower_third",
	"bottom_left", "bottom_center", "bottom_right", "bottom_bar",
	"fullscreen_above", "fullscreen_below"
];

module.exports = NodeHelper.create({

	start () {
		this.liveState = [];
		this.configPath = path.resolve(global.root_path, global.configuration_file || "config/config.js");

		/*
		 * Which modules had their node helper started at boot. app.js skips
		 * `disabled` entries when loading helpers (js/app.js:216), so this is the
		 * authoritative set — anything outside it that needs a helper cannot be
		 * satisfied by a page reload alone.
		 */
		this.bootHelpers = new Set();
		try {
			for (const m of this.readConfig().modules || []) {
				if (!m.disabled) this.bootHelpers.add(m.module);
			}
		} catch {
			// A broken config is reported later, when the UI asks for state.
		}

		// Friendly URL. `public/` is already served at /MMM-WidgetManager by NodeHelper.
		if (this.expressApp) {
			this.expressApp.get("/widgets", (req, res) => res.redirect("/MMM-WidgetManager/index.html"));

			/*
			 * Flip the mirror's theme over HTTP, so it can be driven from a phone
			 * shortcut or a script without opening the panel. Runtime only — use
			 * the panel's toggle and Save to make it survive a restart.
			 */
			this.expressApp.get("/widgets/theme/:mode", (req, res) => {
				const theme = req.params.mode === "light" ? "light" : "dark";
				this.sendSocketNotification("WM_THEME", { theme });
				res.json({ ok: true, theme });
			});

			/*
			 * What the mirror is actually doing right now: which widgets are
			 * loaded, how long since each last redrew, and the scale the
			 * auto-fit settled on per region. The panel reads the same data
			 * over the socket; this makes it inspectable without a browser.
			 */
			this.expressApp.get("/widgets/live", (req, res) => {
				res.json({ ok: true, live: this.liveState || [], fits: this.liveFits || {} });
			});

			// The parameters a given widget actually accepts, read from its source.
			this.expressApp.get("/widgets/params/:module", (req, res) => {
				res.json(this.readDefaults(req.params.module));
			});
		}
		Log.info(`[MMM-WidgetManager] ready — config at ${this.configPath}`);
	},

	/**
	 * The parameters a module accepts, lifted from its own `defaults` block.
	 *
	 * Read from source rather than kept as a hand-written list, so it cannot drift
	 * as modules change and so third-party widgets are documented too. Every
	 * module in this install already writes `key: value, // what it does`, which
	 * is exactly what this needs.
	 *
	 * Deliberately textual: `defaults` can contain computed expressions
	 * (`lang: config.language` in the stock weather module), so the default is
	 * reported as written rather than evaluated. Nothing here is executed.
	 * @param {string} name module name
	 * @returns {object} { ok, module, params: [{key, value, note}], source }
	 */
	readDefaults (name) {
		// Only ever a module name — never a path fragment from the request.
		if (!/^[\w-]+$/.test(name)) return { ok: false, error: "bad module name" };

		const roots = [
			path.join(__dirname, "..", name, `${name}.js`),
			// Stock modules live in defaultmodules/, not modules/default/.
			path.join(__dirname, "..", "..", "defaultmodules", name, `${name}.js`)
		];
		const file = roots.find((p) => fs.existsSync(p));
		if (!file) return { ok: false, error: "no source found for this widget" };

		let src;
		try {
			src = fs.readFileSync(file, "utf8");
		} catch (err) {
			return { ok: false, error: err.message };
		}

		const start = src.indexOf("defaults: {");
		if (start === -1) return { ok: false, error: "this widget declares no defaults" };

		// Walk braces rather than regex to the first "}", so nested objects and
		// arrays inside a default value don't truncate the block early.
		let depth = 0;
		let end = -1;
		for (let i = src.indexOf("{", start); i < src.length; i++) {
			if (src[i] === "{") depth++;
			else if (src[i] === "}") {
				depth--;
				if (depth === 0) { end = i; break; }
			}
		}
		if (end === -1) return { ok: false, error: "could not read the defaults block" };

		const params = [];
		for (const raw of src.slice(src.indexOf("{", start) + 1, end).split("\n")) {
			// Only top-level `key: value` lines; nested ones are indented further
			// and would read as parameters that don't exist.
			const m = raw.match(/^\t{2}([A-Za-z_$][\w$]*)\s*:\s*(.*?)\s*$/);
			if (!m) continue;
			const [, key, rest] = m;
			const cut = rest.indexOf("//");
			const value = (cut === -1 ? rest : rest.slice(0, cut)).replace(/,\s*$/, "").trim();
			const note = cut === -1 ? "" : rest.slice(cut + 2).trim();
			params.push({ key, value: value || "…", note });
		}

		return {
			ok: params.length > 0,
			module: name,
			params,
			source: path.relative(path.join(__dirname, "..", ".."), file),
			error: params.length ? undefined : "could not parse this widget's defaults"
		};
	},

	/**
	 * Read config.js fresh from disk, bypassing require's cache.
	 * @returns {object} the parsed MagicMirror config
	 */
	readConfig () {
		const resolved = require.resolve(this.configPath);
		delete require.cache[resolved];
		return require(this.configPath);
	},

	/**
	 * Scan defaultmodules/ and modules/ for anything loadable.
	 * A directory counts as a module when it contains <name>.js.
	 * @returns {Array<object>} discovered modules
	 */
	discoverModules () {
		const found = [];
		const scan = (base, builtin) => {
			if (!fs.existsSync(base)) return;
			for (const name of fs.readdirSync(base)) {
				if (name.startsWith(".") || name === "node_modules") continue;
				const dir = path.join(base, name);
				if (!fs.statSync(dir).isDirectory()) continue;
				if (fs.existsSync(path.join(dir, `${name}.js`))) found.push({ name, builtin });
			}
		};
		scan(path.join(global.root_path, "defaultmodules"), true);
		scan(path.join(global.root_path, "modules"), false);
		return found.sort((a, b) => a.name.localeCompare(b.name));
	},

	/**
	 * Write config.js back out, keeping a timestamped backup of the previous file.
	 *
	 * The file is emitted as JSON wrapped in the standard config.js scaffolding.
	 * JSON is a strict subset of JS so the result always parses, but comments and
	 * computed expressions in the original file do not survive a save.
	 * @param {object} cfg the full config object to persist
	 * @returns {string} path of the backup that was written
	 */
	writeConfig (cfg) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const backup = `${this.configPath}.backup-${stamp}`;
		fs.copyFileSync(this.configPath, backup);

		const body = [
			"/* MagicMirror² config",
			" *",
			" * Written by MMM-WidgetManager. Comments and computed expressions from a",
			" * hand-edited config are not preserved across a save — the previous file is",
			` * kept alongside this one as ${path.basename(backup)}`,
			" */",
			`let config = ${JSON.stringify(cfg, null, "\t")};`,
			"",
			"/*************** DO NOT EDIT THE LINE BELOW ***************/",
			"if (typeof module !== \"undefined\") { module.exports = config; }",
			""
		].join("\n");

		fs.writeFileSync(this.configPath, body, "utf8");
		Log.info(`[MMM-WidgetManager] config saved, backup at ${backup}`);
		return backup;
	},

	/**
	 * Decide whether a change genuinely needs a full process restart.
	 *
	 * Node helpers are instantiated only at boot, and disabled entries are skipped
	 * then (js/app.js:216). So a module that is now enabled but had no helper
	 * started at boot — whether freshly added or just un-parked — cannot be
	 * satisfied by a page reload. Everything else (moves, reorders, config edits,
	 * removals, parking) can.
	 * @param {Array<object>} after the incoming module list
	 * @returns {string} reason for a restart, or "" if none is needed
	 */
	needsRestart (after) {
		for (const m of after) {
			if (m.disabled || this.bootHelpers.has(m.module)) continue;
			const helper = path.join(global.root_path, "modules", m.module, "node_helper.js");
			if (fs.existsSync(helper)) {
				return `"${m.module}" needs a background service that only starts at boot — restart to finish enabling it.`;
			}
		}
		return "";
	},

	/**
	 * Relaunch the mirror by handing off to a detached helper script, so the
	 * restart survives this process being killed.
	 */
	restartMirror () {
		/*
		 * `restartCommand` wins when set, because the bundled script can only
		 * know how *this* module was installed, never how the mirror was
		 * started. pm2, systemd, Docker and `npm start` each need their own
		 * command, and none of them is guessable from in here.
		 */
		let custom = "";
		try {
			// Read from config.js rather than this.config: MagicMirror does not
			// hand a module's own config to its node helper.
			const self = (this.readConfig().modules || []).find((m) => m.module === "MMM-WidgetManager");
			custom = self?.config?.restartCommand || "";
		} catch { /* fall back to the bundled script */ }
		const cmd = custom || `/bin/bash ${JSON.stringify(path.join(this.path, "restart.sh"))}`;
		Log.info(`[MMM-WidgetManager] restart requested: ${cmd}`);
		const child = spawn(cmd, {
			shell: true,
			detached: true,
			stdio: "ignore",
			cwd: global.root_path,
			env: process.env
		});
		child.unref();
	},

	socketNotificationReceived (notification, payload) {
		switch (notification) {

			// Mirror frontend reporting which modules are loaded and their visibility.
			case "WM_REGISTER":
				/*
				 * The mirror used to send a bare array. It now sends the module
				 * list plus the auto-fit scale per region, so accept both shapes
				 * — a stale browser tab can still be sending the old one.
				 */
				this.liveState = Array.isArray(payload) ? payload : (payload?.modules || []);
				this.liveFits = Array.isArray(payload) ? {} : (payload?.fits || {});
				this.sendSocketNotification("WM_LIVE_STATE", { live: this.liveState, fits: this.liveFits });
				break;

			// UI asking for everything it needs to draw itself.
			case "WM_GET_STATE": {
				let cfg = null;
				let error = null;
				try {
					cfg = this.readConfig();
				} catch (err) {
					error = err.message;
					Log.error(`[MMM-WidgetManager] could not read config: ${err.message}`);
				}
				// Ask the mirror to re-report; its answer arrives as a later WM_LIVE_STATE.
				this.sendSocketNotification("WM_QUERY", {});
				this.sendSocketNotification("WM_STATE", {
					regions: REGIONS,
					config: cfg,
					available: this.discoverModules(),
					live: this.liveState,
					configPath: this.configPath,
					version: global.version,
					error
				});
				break;
			}

			case "WM_SAVE": {
				try {
					const cfg = this.readConfig();
					cfg.modules = payload.modules;
					const backup = this.writeConfig(cfg);

					/*
					 * Push the new layout into the object the /config route serves.
					 * global.config and that object are the same reference (app.js
					 * assigns global.config = configObj.fullConf, and the very same
					 * configObj is handed to new Server()), so mutating it here means
					 * the next page load receives this layout — no process restart.
					 */
					if (global.config) global.config.modules = payload.modules;

					const restart = this.needsRestart(payload.modules);
					this.sendSocketNotification("WM_SAVED", {
						ok: true,
						backup: path.basename(backup),
						needsRestart: restart
					});

					// Tell the mirror page to pick the new config up.
					if (!restart) this.sendSocketNotification("WM_RELOAD", {});
				} catch (err) {
					Log.error(`[MMM-WidgetManager] save failed: ${err.message}`);
					this.sendSocketNotification("WM_SAVED", { ok: false, error: err.message });
				}
				break;
			}

			/*
			 * Relayed straight back out so the mirror instance picks them up. The UI
			 * and the mirror share this namespace, so a re-emit is all it takes.
			 */
			case "WM_TOGGLE":
				this.sendSocketNotification("WM_TOGGLE", payload);
				break;

			case "WM_MOVE":
				this.sendSocketNotification("WM_MOVE", payload);
				break;

			case "WM_THEME":
				this.sendSocketNotification("WM_THEME", payload);
				break;

			case "WM_SIZE":
				this.sendSocketNotification("WM_SIZE", payload);
				break;

			case "WM_RESTART":
				this.sendSocketNotification("WM_RESTARTING", {});
				this.restartMirror();
				break;
		}
	}
});
