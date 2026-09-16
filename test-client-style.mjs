// Offline assertions for the client half (reasoning-box height cap).
// The client bundle runs in the browser; here we pin the contract the DSH
// host actually enforces when scanning loader entries (dsh-client-modules):
//   - `dsh.client` declared with platform "web" ⇒ exports["./client"] MUST exist
//   - the bundle registers window.__ModuleLoader__.load({id: <packageName>, factory})
//   - the factory returns a cordis-plugin-shaped exports ({name, apply})
//   - CSS injection happens at factory scope and targets the stable
//     `_thinkBody` class suffix (hash-proof across ui-chat builds)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// --- package wiring ---
assert.equal(pkg.dsh?.client?.platform, "web", "dsh.client.platform must be web");
assert.equal(pkg.dsh?.client?.immediately, true, "style must apply at boot, not lazily");
assert.equal(pkg.exports?.["./client"], "./client/client.js", 'exports["./client"] must point at the bundle');
assert.equal(pkg.exports?.["./cordis.patch.yml"], "./cordis.patch.yml", "adding exports must not break the bundle patch subpath");
assert.equal(pkg.exports?.["."], "./lib/index.js", "root export must keep resolving the host half");
assert.ok(pkg.files.includes("client"), "client dir must be packed into installs");

// --- bundle behaviour, executed in a minimal fake DOM ---
const source = readFileSync(new URL("./client/client.js", import.meta.url), "utf8");

const styleTags = [];
const listeners = [];
const fakeDocument = {
	querySelector: () => null,
	createElement: () => {
		const tag = { dataset: {}, textContent: "" };
		styleTags.push(tag);
		return tag;
	},
	head: { appendChild: () => {} },
	body: {},
	addEventListener: (type) => listeners.push(type),
	querySelectorAll: () => [],
};
let registration;
const sandbox = {
	window: { __ModuleLoader__: { load: (reg) => (registration = reg) } },
	document: fakeDocument,
	Element: class {},
	WeakMap,
	MutationObserver: class {
		observe() {}
	},
	requestAnimationFrame: () => {},
};
vm.runInNewContext(source, sandbox, { filename: "client/client.js" });

assert.ok(registration, "bundle must register through __ModuleLoader__.load");
assert.equal(registration.id, pkg.name, "registration id must equal the package name (host derives entry.id from it)");

const exportsObj = registration.factory();
assert.equal(typeof exportsObj.apply, "function", "factory must return a cordis plugin (apply)");
assert.equal(typeof exportsObj.name, "string", "factory must return a cordis plugin (name)");

assert.equal(styleTags.length, 1, "exactly one style tag injected at factory scope");
const css = styleTags[0].textContent;
assert.match(css, /_thinkBody/, "cap must target the stable _thinkBody suffix, not a build hash");
assert.match(css, /max-height:var\(--claude-driver-think-max-height,\s*\d+px\)/, "height must be tunable via CSS variable with a px default");
assert.match(css, /overflow-y:auto/, "capped box must scroll, not clip");
assert.equal(styleTags[0].dataset.plugin, "dsh-claude-driver", "style tag must carry the plugin marker the module system claims");
assert.ok(listeners.includes("scroll"), "follow-the-tail must track user scroll to know when to unpin");

// Re-running with the style already present must not duplicate it.
styleTags.length = 0;
sandbox.document.querySelector = () => ({});
registration = void 0;
vm.runInNewContext(source, sandbox, { filename: "client/client.js" });
registration.factory();
assert.equal(styleTags.length, 0, "second execution must not inject a duplicate style tag");

console.log("test-client-style: all assertions passed");
