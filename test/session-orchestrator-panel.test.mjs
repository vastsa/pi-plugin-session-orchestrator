import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { deferred, pluginRoot } from "./session-orchestrator.harness.mjs";

const source = readFileSync(join(pluginRoot, "renderer/panel.js"), "utf8");
const html = readFileSync(join(pluginRoot, "renderer/index.html"), "utf8");
const tick = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

function element(dataset = {}) {
  const events = new Map();
  return {
    dataset, events, innerHTML: "", textContent: "", disabled: false, hidden: false,
    addEventListener: (name, callback) => events.set(name, callback),
    setAttribute: () => undefined, removeAttribute: () => undefined,
    querySelectorAll: () => [], focus: () => undefined,
  };
}

function panel(invoke) {
  const root = element();
  const refresh = element();
  const error = element();
  const documentEvents = new Map();
  const windowEvents = new Map();
  const timers = new Map();
  let timer = 0;
  const document = {
    hidden: false, activeElement: undefined, documentElement: { lang: "en" },
    getElementById: (id) => ({ workers: root, refresh, error })[id],
    querySelectorAll: () => [],
    addEventListener: (name, callback) => documentEvents.set(name, callback),
  };
  const window = {
    pluginBridge: { invoke },
    setTimeout: (callback) => { timers.set(++timer, callback); return timer; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, callback) => windowEvents.set(name, callback),
  };
  vm.runInNewContext(source, { window, document });
  return { root, refresh, error, window, document, windowEvents, documentEvents, timers };
}

test("panel preserves the host chrome contract and has no external runtime assets", () => {
  assert.match(html, /name="pi-plugin-chrome" content="v3"/);
  assert.match(html, /PI-Desktop owns exactly a transparent 46px drag band/);
  assert.match(html, /three-button[\s\S]*window-control capsule/);
  assert.match(html, /var\(--pi-plugin-titlebar-height, 46px\)/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("host provenance, status and recent exchanges render escaped with real Session IDs", async () => {
  const p = panel(async () => ({ workers: [{
    sessionId: "real-session", title: '<img src="x" onerror="bad()">', status: "running", modelKey: "provider/model",
    currentTask: { senderSession: { sessionId: "real-parent", title: "Parent <unsafe>" }, text: "<script>bad()</script>" },
    recentExchanges: [{ direction: "incoming", peer: { sessionId: "peer", title: "Peer" }, kind: "task", status: "queued", preview: '<a href="bad">content</a>' }],
  }] }));
  await tick();
  assert.match(p.root.innerHTML, /real-session/);
  assert.match(p.root.innerHTML, /real-parent/);
  assert.match(p.root.innerHTML, /Task from/);
  assert.match(p.root.innerHTML, /Running/);
  assert.match(p.root.innerHTML, /&lt;script&gt;/);
  assert.match(p.root.innerHTML, /&lt;img/);
  assert.doesNotMatch(p.root.innerHTML, /<script>|<img /);
  assert.match(p.root.innerHTML, /data-stop="real-session"/);
  p.window.__sessionOrchestratorPanel.updateLocale("zh-CN");
  assert.match(p.root.innerHTML, /任务来源/);
  p.windowEvents.get("pagehide")();
});

test("a failed Stop restores the button and duplicate clicks cannot issue duplicate cancellation", async () => {
  const pending = deferred();
  let cancels = 0;
  const p = panel(async (channel, payload) => {
    if (channel === "workers.cancel") {
      assert.equal(payload.sessionId, "existing");
      cancels += 1;
      return pending.promise;
    }
    return { workers: [] };
  });
  await tick();
  const button = element({ stop: "existing" });
  const event = { target: { closest: () => button } };
  const first = p.root.events.get("click")(event);
  await tick();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Stopping…");
  await p.root.events.get("click")(event);
  assert.equal(cancels, 1);
  pending.reject(new Error("Host cancellation denied"));
  await first;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Stop");
  assert.match(p.error.textContent, /Host cancellation denied/);
  p.windowEvents.get("pagehide")();
});

test("page close clears refresh ownership and ignores a late response", async () => {
  const pending = deferred();
  const p = panel(async () => pending.promise);
  const before = p.root.innerHTML;
  p.windowEvents.get("pagehide")();
  pending.resolve({ workers: [{ sessionId: "late", title: "Late", status: "running" }] });
  await tick();
  assert.equal(p.root.innerHTML, before);
  assert.equal(p.timers.size, 0);
});
