(() => {
  "use strict";

  const bridge = window.pluginBridge;
  const root = document.getElementById("workers");
  const refreshButton = document.getElementById("refresh");
  const errorNode = document.getElementById("error");
  const pending = new Set();
  let timer = 0;
  let loading = false;
  let disposed = false;
  let workers = [];
  let locale = "en";

  const strings = {
    en: {
      eyebrow: "SESSION ORCHESTRATOR", title: "Agents", refresh: "Refresh",
      empty: "No recent sessions yet.", open: "Open Session", stop: "Stop",
      stopping: "Stopping…", opening: "Opening…", completed: "Completed",
      running: "Running", queued: "Queued", idle: "Idle",
      waiting_permission: "Waiting for permission", failed: "Failed",
      cancelled: "Cancelled", interrupted: "Interrupted", unavailable: "Unavailable",
      unknown: "Not observed", loadFailed: "Unable to read session status",
      actionFailed: "Session action failed", createdBy: "Created by", taskFrom: "Task from",
      incoming: "From", outgoing: "To", task: "Task", message: "Message",
      completion: "Completion", recent: "Recent messages",
    },
    "zh-CN": {
      eyebrow: "SESSION ORCHESTRATOR", title: "Agents", refresh: "刷新",
      empty: "还没有最近使用的会话。", open: "打开会话", stop: "停止",
      stopping: "停止中…", opening: "打开中…", completed: "已完成",
      running: "运行中", queued: "已排队", idle: "空闲",
      waiting_permission: "等待权限", failed: "失败", cancelled: "已取消",
      interrupted: "已中断", unavailable: "不可用", unknown: "尚未查询",
      loadFailed: "无法读取会话状态", actionFailed: "会话操作失败",
      createdBy: "创建来源", taskFrom: "任务来源", incoming: "来自", outgoing: "发往",
      task: "任务", message: "消息", completion: "完成通知", recent: "最近往来",
    },
  };

  function t(key) {
    return strings[locale]?.[key] || strings.en[key] || key;
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function preview(value, limit = 320) {
    const content = String(value || "");
    return content.length > limit ? `${content.slice(0, limit - 1)}…` : content;
  }

  function sourceLabel(source) {
    return source ? `${source.title || source.sessionId} (${source.sessionId})` : "";
  }

  function showError(message) {
    errorNode.textContent = message || "";
    errorNode.hidden = !message;
  }

  function render(nextWorkers) {
    if (disposed) return;
    workers = nextWorkers;
    const focused = document.activeElement?.dataset;
    const focusTarget = focused?.open || focused?.stop;
    const focusAction = focused?.open ? "open" : "stop";
    if (!workers.length) {
      root.innerHTML = `<div class="empty">${escapeHtml(t("empty"))}</div>`;
      return;
    }
    root.innerHTML = workers.map((worker) => {
      const active = ["queued", "running", "waiting_permission"].includes(worker.status);
      const busy = pending.has(worker.sessionId);
      const glyph = worker.status === "completed" ? "✓" : "●";
      const source = worker.currentTask?.senderSession || worker.createdBySession;
      const sourceKind = worker.currentTask?.senderSession ? "taskFrom" : "createdBy";
      const exchanges = Array.isArray(worker.recentExchanges) ? worker.recentExchanges.slice(0, 3) : [];
      return `
        <article class="worker" aria-busy="${busy}">
          <div class="worker-row">
            <span class="status status-${escapeHtml(worker.status)}" aria-hidden="true">${glyph}</span>
            <span class="worker-title" title="${escapeHtml(worker.title)}">${escapeHtml(worker.title || worker.sessionId)}</span>
            <span class="status-label">${escapeHtml(t(worker.status))}</span>
          </div>
          <div class="session-id" title="${escapeHtml(worker.sessionId)}">${escapeHtml(worker.sessionId)}</div>
          ${worker.modelKey ? `<div class="worker-model">${escapeHtml(worker.modelKey)}</div>` : ""}
          ${source ? `<div class="worker-source" title="${escapeHtml(sourceLabel(source))}">${escapeHtml(t(sourceKind))}: ${escapeHtml(sourceLabel(source))}</div>` : ""}
          ${worker.currentTask?.text ? `<div class="worker-task">${escapeHtml(preview(worker.currentTask.text))}</div>` : ""}
          ${worker.error || worker.result?.error ? `<div class="worker-error">${escapeHtml(preview(worker.error || worker.result.error))}</div>` : ""}
          ${exchanges.length ? `<ul class="exchanges" aria-label="${escapeHtml(t("recent"))}">${exchanges.map((entry) => `
            <li><div class="exchange-source" title="${escapeHtml(sourceLabel(entry.peer))}">${escapeHtml(t(entry.direction))} ${escapeHtml(entry.peer?.title || entry.peer?.sessionId || "")} · ${escapeHtml(t(entry.kind))} · ${escapeHtml(t(entry.status))}</div>
            <div class="exchange-preview">${escapeHtml(preview(entry.preview, 160))}</div></li>`).join("")}</ul>` : ""}
          <div class="actions">
            <button type="button" data-open="${escapeHtml(worker.sessionId)}" ${busy ? "disabled" : ""}>${escapeHtml(t("open"))}</button>
            <button class="secondary" type="button" data-stop="${escapeHtml(worker.sessionId)}" ${!active || busy ? "disabled" : ""}>${escapeHtml(t("stop"))}</button>
          </div>
        </article>`;
    }).join("");
    if (focusTarget) {
      const button = [...root.querySelectorAll("button")].find((node) => node.dataset[focusAction] === focusTarget);
      button?.focus({ preventScroll: true });
    }
  }

  async function refresh() {
    if (disposed || loading || pending.size || !bridge?.invoke) return;
    loading = true;
    refreshButton.disabled = true;
    refreshButton.setAttribute("aria-busy", "true");
    showError("");
    try {
      const result = await bridge.invoke("workers.list");
      if (!disposed) render(Array.isArray(result?.workers) ? result.workers : []);
    } catch (error) {
      if (!disposed) showError(error?.message || t("loadFailed"));
    } finally {
      loading = false;
      refreshButton.disabled = false;
      refreshButton.removeAttribute("aria-busy");
    }
  }

  function schedule() {
    window.clearTimeout(timer);
    if (!disposed && !document.hidden) {
      timer = window.setTimeout(async () => {
        await refresh();
        schedule();
      }, 5_000);
    }
  }

  function updateLocale(nextLocale) {
    locale = String(nextLocale || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      if (strings[locale][node.dataset.i18n]) node.textContent = t(node.dataset.i18n);
    });
    render(workers);
  }

  refreshButton.addEventListener("click", async () => {
    await refresh();
    schedule();
  });

  root.addEventListener("click", async (event) => {
    const target = event.target.closest?.("button");
    if (!target || target.disabled) return;
    const sessionId = target.dataset.open || target.dataset.stop;
    if (!sessionId || pending.has(sessionId)) return;
    const opening = Boolean(target.dataset.open);
    pending.add(sessionId);
    target.disabled = true;
    target.setAttribute("aria-busy", "true");
    target.textContent = t(opening ? "opening" : "stopping");
    showError("");
    try {
      await bridge.invoke(opening ? "workers.open" : "workers.cancel", { sessionId });
      pending.delete(sessionId);
      await refresh();
    } catch (error) {
      if (!disposed) showError(error?.message || t("actionFailed"));
    } finally {
      pending.delete(sessionId);
      target.disabled = false;
      target.removeAttribute("aria-busy");
      target.textContent = t(opening ? "open" : "stop");
      schedule();
    }
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) window.clearTimeout(timer);
    else {
      await refresh();
      schedule();
    }
  });
  window.addEventListener("pagehide", () => {
    disposed = true;
    window.clearTimeout(timer);
  }, { once: true });

  window.__sessionOrchestratorPanel = { render, refresh, updateLocale, showError };
  updateLocale(document.documentElement.lang);
  void refresh().then(schedule);
})();
