"use strict";

const manifest = require("./manifest.json");
const { createReferenceStore } = require("./state.js");
const { createRuntime, taskError } = require("./runtime.js");
const { createActions } = require("./actions.js");

const COMMAND_ID = "pi.session-orchestrator.open";
const TOOL_NAME = "SessionTask";
let current;

async function onLoad() {
  const store = await createReferenceStore(pi.plugin);
  const runtime = createRuntime(store, pi);
  const actions = createActions(runtime);
  const active = { store, runtime, actions };
  try {
    await pi.commands.register({
      id: COMMAND_ID,
      title: "Session Orchestrator: Open Agents",
      keywords: ["agent", "session", "orchestrator", "agents"],
      category: "Agent",
      run: () => pi.ui.openPanel(),
    });
    await pi.agent.registerTool({ ...manifest.contributes.agentTools[0], execute: actions.execute });
    current = active;
  } catch (error) {
    runtime.dispose();
    await Promise.allSettled([
      pi.agent.unregisterTool(TOOL_NAME),
      pi.commands.unregister(COMMAND_ID),
    ]);
    throw error;
  }
}

async function onUnload() {
  const active = current;
  current = undefined;
  active?.runtime.dispose();
  await Promise.allSettled([
    pi.agent.unregisterTool(TOOL_NAME),
    pi.commands.unregister(COMMAND_ID),
  ]);
  if (active) await active.store.flush();
}

async function onPanelInvoke(channel, payload) {
  if (!current) throw taskError("NOT_FOUND", "Session Orchestrator is not loaded");
  switch (channel) {
    case "workers.list": return current.actions.panelList();
    case "workers.cancel": return current.actions.panelCancel(payload);
    case "workers.open": return current.actions.panelOpen(payload);
    default: throw taskError("UNSUPPORTED", `Unsupported panel channel: ${channel}`);
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
