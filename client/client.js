/**
 * dsh-claude-driver client half: cap the expanded reasoning ("思考") body at a
 * max height and keep it scrolled to the latest text while streaming, and show
 * one composer line for Claude Code sessions: session price plus the 5-hour and
 * weekly plan windows.
 *
 * The reasoning body is rendered by @deepseek-ai/dsh-client-ui-chat's
 * ReasoningRow component. Its CSS-module class is hash-prefixed per build
 * (e.g. `wM8ffq_thinkBody`), so we match on the stable `_thinkBody` suffix
 * instead of the hash. If a future ui-chat build renames the class outright,
 * this degrades to a no-op (unbounded box, today's stock behaviour) — it can
 * never break the chat view.
 *
 * Height is tunable without a rebuild via the CSS variable
 * `--claude-driver-think-max-height` (default 320px).
 */
window.__ModuleLoader__.load({
	id: "dsh-claude-driver",
	factory: (require) => {
		var module = { exports: {} };

		// Same metrics and DSW tokens as the OpenCode Go meter: an inline pill in the
		// dock row, and a body-portalled fixed card that cannot overlap its neighbours.
		const BAR_CSS = [
			".cdb_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}",
			".cdb_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}",
			".cdb_pill:hover,.cdb_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".cdb_mark{align-items:center;gap:5px;display:inline-flex}",
			".cdb_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}",
			".cdb_seg{align-items:center;gap:5px;display:inline-flex}",
			".cdb_ring{flex:none}",
			".cdb_ring_track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}",
			".cdb_ring_fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2px;stroke-linecap:round;transition:stroke-dasharray .35s ease}",
			".cdb_ring_fill[data-tone=warn]{stroke:var(--dsw-alias-state-warn-primary)}",
			".cdb_ring_fill[data-tone=danger]{stroke:var(--dsw-alias-state-error-primary)}",
			".cdb_sep{color:var(--dsw-alias-separator-primary);margin:0 2px}",
			".cdb_panel{position:fixed;z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;outline:none}",
			".cdb_panel_title{margin-bottom:8px;font-weight:500;color:var(--dsw-alias-label-primary)}",
			".cdb_panel_rule{border-top:1px solid var(--dsw-alias-border-l2);margin-bottom:10px}",
			".cdb_panel_details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0}",
			".cdb_panel_dt{color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".cdb_panel_dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;min-width:0;font-weight:500}",
			".cdb_panel_dd[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
			".cdb_panel_dd[data-tone=danger]{color:var(--dsw-alias-state-error-primary)}",
		].join("\n");

		const css = [
			'[class*="_thinkBody"]{',
			"max-height:var(--claude-driver-think-max-height,320px);",
			"overflow-y:auto;",
			"overscroll-behavior:contain;",
			"}",
		].join("") + BAR_CSS;

		const tagId = "dsh-claude-driver/reasoning-cap.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-claude-driver";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/**
		 * Follow-the-tail: while reasoning text streams into a capped body, keep
		 * it pinned to the bottom so the newest thought stays visible — unless
		 * the user has scrolled up to read something, in which case leave them
		 * alone until they return to the bottom themselves.
		 *
		 * Pinning is self-consistent without a "programmatic scroll" flag: every
		 * scroll event (ours or the user's) re-derives pinned-ness from whether
		 * the box is near the bottom. Our own pin-to-bottom therefore re-asserts
		 * pinned=true; a user scrolling up flips it to false; scrolling back
		 * down re-arms it.
		 */
		const NEAR_BOTTOM_PX = 24;
		const pinned = new WeakMap();
		const isThinkBody = (el) => el instanceof Element && /(?:^|\s)[^\s]*_thinkBody(?:\s|$)/.test(el.className || "");

		if (typeof document !== "undefined") {
			document.addEventListener(
				"scroll",
				(event) => {
					const el = event.target;
					if (!isThinkBody(el)) return;
					pinned.set(el, el.scrollHeight - el.clientHeight - el.scrollTop <= NEAR_BOTTOM_PX);
				},
				{ capture: true, passive: true },
			);

			let scheduled = false;
			const followTails = () => {
				scheduled = false;
				for (const el of document.querySelectorAll('[class*="_thinkBody"]')) {
					if (el.scrollHeight <= el.clientHeight) continue;
					if (pinned.get(el) === false) continue;
					el.scrollTop = el.scrollHeight;
				}
			};
			const observer = new MutationObserver(() => {
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(followTails);
			});
			const start = () => observer.observe(document.body, { childList: true, characterData: true, subtree: true });
			if (document.body) start();
			else document.addEventListener("DOMContentLoaded", start, { once: true });
		}

		const USAGE_ROUTE = "/claude-usage.json";
		const USAGE_POLL_MS = 15000;
		const PANEL_MARGIN = 12;
		const PANEL_GAP = 8;
		const WINDOW_LABELS = [
			["fiveHour", "5h", "5-hour window"],
			["weekly", "Week", "Week window"],
		];

		/**
		 * The bar's content, as plain data: the label, the session price for the
		 * card ("n/a" when unpriced, null before any turn) and the plan windows that
		 * Claude reports, rounded. A session that has run Claude turns owns it
		 * through its stats; a session routed to this provider owns it before the
		 * first turn settles too, so other models' sessions never carry it.
		 */
		function barSegments({ stats, snapshot, provider, route }) {
			const cost = stats ? (stats.costUsd === null ? "n/a" : `$${stats.costUsd.toFixed(4)}`) : null;
			const windows = snapshot?.ok === true
				? WINDOW_LABELS.filter(([key]) => snapshot.windows?.[key]).map(([key, label, title]) => {
						const raw = snapshot.windows[key].percent;
						return { key, label, title, percent: Math.round(raw), tone: raw >= 90 ? "danger" : raw >= 70 ? "warn" : "", resetsAt: snapshot.windows[key].resetsAt };
					})
				: [];
			// Before the first turn settles there are no session stats, but a
			// session already routed to this provider (a goal-first session whose
			// first turn runs for hours) still owns the meter.
			const onRoute = typeof provider === "string" && provider !== "" && route === provider;
			return { label: "Claude", cost, windows, visible: windows.length > 0 && (Boolean(stats) || onRoute) };
		}

		const usageResetIn = (iso) => {
			const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
			if (!Number.isFinite(minutes) || minutes <= 0) return "";
			if (minutes < 60) return `${minutes}m`;
			const hours = Math.floor(minutes / 60);
			return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
		};
		const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
		const duration = (ms) => {
			const total = Math.max(0, Math.round(ms / 1000));
			return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
		};

		function mountBar(require) {
			const React = require("react");
			const ReactDOM = require("react-dom");
			const h = React.createElement;

			const RING_RADIUS = 5.5;
			const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
			const Ring = ({ percent, tone }) =>
				h(
					"svg",
					{ className: "cdb_ring", viewBox: "0 0 14 14", width: 14, height: 14, "aria-hidden": true },
					h("circle", { className: "cdb_ring_track", cx: 7, cy: 7, r: RING_RADIUS }),
					h("circle", {
						className: "cdb_ring_fill",
						"data-tone": tone,
						cx: 7,
						cy: 7,
						r: RING_RADIUS,
						strokeDasharray: `${(RING_CIRCUMFERENCE * Math.min(100, Math.max(0, percent))) / 100} ${RING_CIRCUMFERENCE}`,
						transform: "rotate(-90 7 7)",
					}),
				);

			/** Place the card above the trigger, clamped into the viewport. */
			function useAnchoredPlacement(open, rootRef, panelRef) {
				const [position, setPosition] = React.useState(null);
				React.useEffect(() => {
					if (!open) {
						setPosition(null);
						return undefined;
					}
					const place = () => {
						const anchor = rootRef.current;
						if (!anchor) return;
						const rect = anchor.getBoundingClientRect();
						const panel = panelRef.current;
						const width = panel ? panel.offsetWidth : 300;
						const height = panel ? panel.offsetHeight : 200;
						let left = rect.left;
						if (left + width > window.innerWidth - PANEL_MARGIN) left = window.innerWidth - PANEL_MARGIN - width;
						if (left < PANEL_MARGIN) left = PANEL_MARGIN;
						let top = rect.top - PANEL_GAP - height;
						if (top < PANEL_MARGIN) top = Math.min(window.innerHeight - PANEL_MARGIN - height, rect.bottom + PANEL_GAP);
						setPosition({ left: Math.round(left), top: Math.round(top) });
					};
					place();
					const frame = window.requestAnimationFrame(place);
					window.addEventListener("resize", place);
					window.addEventListener("scroll", place, true);
					return () => {
						window.cancelAnimationFrame(frame);
						window.removeEventListener("resize", place);
						window.removeEventListener("scroll", place, true);
					};
				}, [open, rootRef, panelRef]);
				return position;
			}

			/** Close on Escape or a pointerdown outside both the trigger and the card. */
			function useDismiss(open, close, rootRef, panelRef) {
				React.useEffect(() => {
					if (!open) return undefined;
					const onPointerDown = (event) => {
						if (rootRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return;
						close();
					};
					const onKeyDown = (event) => {
						if (event.key === "Escape") close();
					};
					document.addEventListener("pointerdown", onPointerDown, true);
					document.addEventListener("keydown", onKeyDown);
					return () => {
						document.removeEventListener("pointerdown", onPointerDown, true);
						document.removeEventListener("keydown", onKeyDown);
					};
				}, [open, close, rootRef, panelRef]);
			}

			/** One dock meter: the Claude label and the 5h / weekly rings; click for the card. */
			function ClaudeBar({ useProjection }) {
				const stats = useProjection("claudeSessionStats");
				const selection = useProjection("modelSelection");
				const [usage, setUsage] = React.useState(null);
				const [open, setOpen] = React.useState(false);
				const rootRef = React.useRef(null);
				const panelRef = React.useRef(null);
				const close = React.useCallback(() => setOpen(false), []);
				React.useEffect(() => {
					let alive = true;
					const load = () =>
						fetch(USAGE_ROUTE, { cache: "no-store", headers: { accept: "application/json" } })
							.then((response) => response.json())
							.then((payload) => {
								if (!alive) return;
								setUsage({ snapshot: payload?.snapshot ?? null, provider: typeof payload?.provider === "string" ? payload.provider : null });
							})
							.catch(() => {});
					void load();
					const timer = setInterval(load, USAGE_POLL_MS);
					return () => {
						alive = false;
						clearInterval(timer);
					};
				}, []);
				useDismiss(open, close, rootRef, panelRef);
				const position = useAnchoredPlacement(open, rootRef, panelRef);
				const route = selection?.next?.provider ?? selection?.lastUsed?.provider ?? null;
				const bar = barSegments({ stats, snapshot: usage?.snapshot ?? null, provider: usage?.provider ?? null, route });
				if (!bar.visible) return null;

				const worst = bar.windows.reduce((tone, w) => (w.tone === "danger" || (w.tone === "warn" && tone !== "danger") ? w.tone : tone), "");
				const segments = [];
				bar.windows.forEach((w, i) => {
					if (i > 0) segments.push(h("span", { key: `sep-${w.key}`, className: "cdb_sep", "aria-hidden": true }, "·"));
					segments.push(h("span", { key: w.key, className: "cdb_seg" }, h("span", null, w.label), h(Ring, { percent: w.percent, tone: w.tone }), h("span", null, `${w.percent}%`)));
				});

				const rows = [];
				if (stats) {
					rows.push(["Session price (est.)", stats.costUsd === null ? "n/a" : `$${stats.costUsd.toFixed(4)}`, ""]);
					rows.push(["Duration", `API ${duration(stats.durationApiMs)} · wall ${duration(stats.durationMs)}`, ""]);
					rows.push(["Requests", String(stats.requests), ""]);
					rows.push(["Cache hit", `${Math.round(stats.cache.hitRate * 100)}% · read ${k(stats.cache.readTokens)} · write ${k(stats.cache.writeTokens)}`, ""]);
					for (const m of stats.models) rows.push([m.model, `${k(m.inputTokens)} in · ${k(m.outputTokens)} out`, ""]);
				}
				for (const w of bar.windows) {
					const resetIn = usageResetIn(w.resetsAt);
					rows.push([w.title, `${w.percent}%${resetIn ? ` · resets in ${resetIn}` : ""}`, w.tone]);
				}

				const panel = open
					? ReactDOM.createPortal(
							h(
								"div",
								{ ref: panelRef, className: "cdb_panel", role: "dialog", "aria-label": "Claude Code usage", tabIndex: -1, style: position || { visibility: "hidden", left: 0, top: 0 } },
								h("div", { className: "cdb_panel_title" }, "Claude Code usage"),
								h("div", { className: "cdb_panel_rule" }),
								h(
									"dl",
									{ className: "cdb_panel_details" },
									rows.flatMap(([label, value, tone], i) => [
										h("dt", { key: `dt${i}`, className: "cdb_panel_dt" }, label),
										h("dd", { key: `dd${i}`, className: "cdb_panel_dd", "data-tone": tone, style: { margin: 0 } }, value),
									]),
								),
							),
							document.body,
						)
					: null;

				return h(
					React.Fragment,
					null,
					h(
						"span",
						{ ref: rootRef, className: "cdb_anchor", "data-composer-stat": "claude-code" },
						h(
							"button",
							{ type: "button", className: "cdb_pill", "data-tone": worst, "aria-haspopup": "dialog", "aria-expanded": open, title: "Claude Code session and plan usage", onClick: () => setOpen(!open) },
							h("span", { className: "cdb_mark", "aria-hidden": true }, h("span", { className: "cdb_dot" }), h("span", null, bar.label)),
							segments,
						),
					),
					panel,
				);
			}
			return ClaudeBar;
		}

		module.exports.name = "claude-driver-client";
		module.exports.inject = ["slots"];
		module.exports.barSegments = barSegments;
		module.exports.apply = (ctx) => {
			const ClaudeBar = mountBar(require);
			// Order 10 sorts after the OpenCode Go meter (2); both are inline pills in the same dock row.
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "claude-driver-bar", order: 10 }, ClaudeBar),
			);
		};
		return module.exports;
	},
});
