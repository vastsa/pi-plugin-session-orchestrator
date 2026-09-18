"use strict";

const manifest = require("./manifest.json");
const { createReferenceStore } = require("./state.js");
const { createRuntime } = require("./runtime.js");
const { createActions } = require("./actions.js");

const TOOL_NAME = "SessionTask";
let current;

async function onLoad() {
  const store = await createReferenceStore(pi.plugin);
  const runtime = createRuntime(store, pi);
  const actions = createActions(runtime);
  const active = { store, runtime, actions };
  try {
    await pi.agent.registerTool({ ...manifest.contributes.agentTools[0], execute: actions.execute });
    current = active;
  } catch (error) {
    runtime.dispose();
    await Promise.allSettled([pi.agent.unregisterTool(TOOL_NAME)]);
    throw error;
  }
}

async function onUnload() {
  const active = current;
  current = undefined;
  active?.runtime.dispose();
  await Promise.allSettled([pi.agent.unregisterTool(TOOL_NAME)]);
  if (active) await active.store.flush();
}

module.exports = { onLoad, onUnload };
