const state = {
  runs: [],
  selected: null,
  sessionId: null,
  events: [],
  executionMode: "stream",
  intentMode: "chat",
  activeTab: "response",
  query: "",
  eventSource: null,
  pollTimer: 0,
  health: null,
  capabilities: null,
  attachments: [],
};

const el = {
  serviceStatus: document.querySelector("#service-status"),
  releaseLabel: document.querySelector("#release-label"),
  uptimeLabel: document.querySelector("#uptime-label"),
  healthTime: document.querySelector("#health-time"),
  runList: document.querySelector("#run-list"),
  runCount: document.querySelector("#run-count"),
  runSearch: document.querySelector("#run-search"),
  sessionTitle: document.querySelector("#session-title"),
  sessionIdLabel: document.querySelector("#session-id"),
  sessionRunCount: document.querySelector("#session-run-count"),
  conversationThread: document.querySelector("#conversation-thread"),
  conversationEmpty: document.querySelector("#conversation-empty"),
  form: document.querySelector("#run-form"),
  tenant: document.querySelector("#tenant-input"),
  input: document.querySelector("#input-field"),
  filePickerButton: document.querySelector("#file-picker-button"),
  fileInput: document.querySelector("#file-input"),
  webUrlInput: document.querySelector("#web-url-input"),
  webUrlAdd: document.querySelector("#web-url-add"),
  attachmentList: document.querySelector("#attachment-list"),
  submit: document.querySelector("#submit-button"),
  submitLabel: document.querySelector(".run-button-label"),
  requestTemplate: document.querySelector("#request-template"),
  empty: document.querySelector("#empty-state"),
  content: document.querySelector("#run-content"),
  metricStatus: document.querySelector("#metric-status"),
  metricDuration: document.querySelector("#metric-duration"),
  metricTokens: document.querySelector("#metric-tokens"),
  metricModel: document.querySelector("#metric-model"),
  response: document.querySelector("#response-output"),
  events: document.querySelector("#event-timeline"),
  raw: document.querySelector("#raw-output"),
  eventCount: document.querySelector("#event-count"),
  live: document.querySelector("#live-indicator"),
  idList: document.querySelector("#id-list"),
  runInfo: document.querySelector("#run-info"),
  planSection: document.querySelector("#plan-section"),
  planList: document.querySelector("#plan-list"),
  capabilityList: document.querySelector("#capability-list"),
  capabilityLimits: document.querySelector("#capability-limits"),
  errorBanner: document.querySelector("#error-banner"),
  errorText: document.querySelector("#error-text"),
  errorClose: document.querySelector("#error-close"),
  menuButton: document.querySelector("#menu-button"),
  newRun: document.querySelector("#new-run-button"),
  inspectorButton: document.querySelector("#inspector-button"),
  inspectorClose: document.querySelector("#inspector-close"),
  shell: document.querySelector(".workspace-shell"),
  scrim: document.querySelector("#mobile-scrim"),
  themeButton: document.querySelector("#theme-button"),
  grafanaLink: document.querySelector("#grafana-link"),
  prometheusLink: document.querySelector("#prometheus-link"),
};

function uuidSuffix(length = 16) {
  return crypto.randomUUID?.().replaceAll("-", "").slice(0, length)
    ?? Math.random().toString(16).slice(2, 2 + length);
}

function createSessionId() {
  return `session-ui-${uuidSuffix(20)}`;
}

function createRequestId() {
  return `req-ui-${uuidSuffix(12)}`;
}

function attachmentId() {
  return `attachment-${uuidSuffix(12)}`;
}

function refreshRequestTemplate() {
  const requestId = createRequestId();
  el.requestTemplate.dataset.requestId = requestId;
  el.requestTemplate.textContent = requestId;
}

function currentRequestId() {
  return el.requestTemplate.dataset.requestId || createRequestId();
}

function showError(error) {
  el.errorText.textContent = error instanceof Error ? error.message : String(error);
  el.errorBanner.hidden = false;
}

function clearError() {
  el.errorBanner.hidden = true;
  el.errorText.textContent = "";
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = body?.error?.message || body?.message || body || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function setServiceStatus(ok, text) {
  el.serviceStatus.className = `status-pill ${ok ? "ok" : "error"}`;
  el.serviceStatus.innerHTML = `<span class="status-dot"></span>${text}`;
}

async function loadHealth() {
  try {
    const health = await request("/health");
    state.health = health;
    setServiceStatus(true, "服务正常");
    el.releaseLabel.textContent = `release: ${health.release_id}`;
    el.uptimeLabel.textContent = `uptime: ${health.uptime_seconds}s`;
    el.healthTime.textContent = `health: ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  } catch (error) {
    setServiceStatus(false, "服务异常");
    showError(error);
  }
}

async function loadCapabilities() {
  try {
    state.capabilities = await request("/v1/capabilities");
    renderCapabilities();
  } catch (error) {
    showError(error);
  }
}

function renderCapabilities() {
  const capabilities = state.capabilities;
  if (!capabilities) {
    el.capabilityList.textContent = "正在加载能力清单…";
    return;
  }
  el.capabilityList.replaceChildren();
  const tools = Array.isArray(capabilities.tools) ? capabilities.tools : [];
  const skills = Array.isArray(capabilities.skills) ? capabilities.skills : [];
  const groups = [
    ["Tools", tools],
    ["Skills", skills],
  ];
  for (const [label, entries] of groups) {
    const group = document.createElement("div");
    group.className = "capability-group";
    const heading = document.createElement("span");
    heading.className = "capability-label";
    heading.textContent = `${label} · ${entries.length}`;
    group.append(heading);
    const chips = document.createElement("div");
    chips.className = "capability-chips";
    for (const entry of entries) {
      const chip = document.createElement(label === "Skills" ? "button" : "span");
      chip.className = "capability-chip";
      chip.textContent = entry.name;
      chip.title = entry.description || "";
      if (label === "Skills") {
        chip.type = "button";
        chip.classList.add("skill-chip");
        chip.addEventListener("click", () => insertSkillReference(entry.name));
      }
      chips.append(chip);
    }
    group.append(chips);
    el.capabilityList.append(group);
  }
  const limits = capabilities.limits || {};
  el.capabilityLimits.textContent =
    `${limits.maxLoopTurns ?? "-"} loop turns · ${limits.maxToolCalls ?? "-"} tool calls`;
}

function insertSkillReference(name) {
  const current = el.input.value;
  const separator = current && !/\s$/.test(current) ? " " : "";
  el.input.value = `${current}${separator}@${name} `;
  el.input.focus();
}

function renderAttachments() {
  el.attachmentList.replaceChildren();
  el.attachmentList.hidden = state.attachments.length === 0;
  for (const attachment of state.attachments) {
    const item = document.createElement("span");
    item.className = "attachment-item";
    const label = document.createElement("span");
    label.textContent = attachment.display || attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", `移除 ${attachment.name}`);
    remove.innerHTML = '<i data-lucide="x"></i>';
    remove.addEventListener("click", () => {
      state.attachments = state.attachments.filter((value) => value.id !== attachment.id);
      renderAttachments();
    });
    item.append(label, remove);
    el.attachmentList.append(item);
  }
  window.lucide?.createIcons();
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    });
    reader.addEventListener("error", () => reject(reader.error || new Error("读取文件失败")));
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  for (const file of files) {
    if (file.size > 8_000_000) {
      showError(new Error(`${file.name} 超过 8 MB`));
      continue;
    }
    try {
      state.attachments.push({
        id: attachmentId(),
        name: file.name,
        mime_type: file.type || "",
        data_base64: await fileBase64(file),
        display: `${file.name} · ${Math.ceil(file.size / 1024)} KB`,
      });
    } catch (error) {
      showError(error);
    }
  }
  el.fileInput.value = "";
  renderAttachments();
}

function addWebAttachment() {
  const value = el.webUrlInput.value.trim();
  if (!value) return;
  let url;
  try {
    url = new URL(value);
  } catch {
    showError(new Error("请输入有效的网页 URL"));
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    showError(new Error("网页 URL 仅支持 http 或 https"));
    return;
  }
  state.attachments.push({
    id: attachmentId(),
    name: url.toString(),
    url: url.toString(),
    display: `网页 · ${url.hostname}`,
  });
  el.webUrlInput.value = "";
  renderAttachments();
}

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return "-";
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(2)}s`;
}

function formatTokens(run) {
  if (!run?.usage_available || !Number.isFinite(run.total_tokens)) return "unknown";
  return new Intl.NumberFormat("zh-CN").format(run.total_tokens);
}

function truncate(value, length = 78) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function runTitle(run) {
  return run?.input?.trim() || run?.attachments?.[0]?.name || "附件任务";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sessionKey(run) {
  return run.session_id || run.run_id;
}

function groupedSessions() {
  const groups = new Map();
  for (const run of state.runs) {
    const key = sessionKey(run);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        sessionId: key,
        latest: run,
        first: run,
        count: 1,
      });
      continue;
    }
    existing.count += 1;
    if (run.created_at > existing.latest.created_at) existing.latest = run;
    if (run.created_at < existing.first.created_at) existing.first = run;
  }
  return [...groups.values()].sort((left, right) =>
    right.latest.created_at.localeCompare(left.latest.created_at),
  );
}

function renderSessionList() {
  const query = state.query.toLowerCase();
  const sessions = groupedSessions().filter((session) => {
    if (!query) return true;
    return [
      session.sessionId,
      session.latest.tenant,
      session.first.input,
      session.latest.status,
    ].join(" ").toLowerCase().includes(query);
  });
  el.runCount.textContent = String(groupedSessions().length);
  el.runList.replaceChildren();
  if (!sessions.length) {
    const note = document.createElement("p");
    note.className = "empty-list-note";
    note.textContent = state.runs.length ? "没有匹配的对话" : "暂无对话记录";
    el.runList.append(note);
    return;
  }
  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = `run-item${state.sessionId === session.sessionId ? " selected" : ""}`;
    item.dataset.sessionId = session.sessionId;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "run-open";
    open.innerHTML = `
      <span class="run-item-top">
        <span class="run-item-title">${escapeHtml(truncate(runTitle(session.first), 46))}</span>
        <span class="run-state ${escapeHtml(session.latest.status)}"></span>
      </span>
      <span class="run-item-bottom">
        <span>${escapeHtml(session.latest.tenant)} · ${session.count} 轮</span>
        <span>${escapeHtml(formatTime(session.latest.created_at))}</span>
      </span>
    `;
    open.addEventListener("click", () => {
      closeSidebar();
      void selectRun(session.latest.run_id);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "session-delete";
    remove.title = "删除会话";
    remove.setAttribute("aria-label", `删除会话 ${truncate(runTitle(session.first), 32)}`);
    remove.innerHTML = `<i data-lucide="trash-2"></i>`;
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteSession(session.sessionId);
    });
    item.append(open, remove);
    el.runList.append(item);
  }
  window.lucide?.createIcons();
}

async function deleteSession(sessionId) {
  if (!window.confirm("删除这个会话及其全部 Run 记录？此操作不可撤销。")) return;
  try {
    await request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    state.runs = state.runs.filter((run) => sessionKey(run) !== sessionId);
    if (state.sessionId === sessionId) {
      resetConversation();
    } else {
      renderSessionList();
    }
    await loadRuns();
  } catch (error) {
    showError(error);
  }
}

function runsInCurrentSession() {
  const merged = new Map();
  for (const run of state.runs) {
    if (state.sessionId && sessionKey(run) === state.sessionId) merged.set(run.run_id, run);
  }
  if (state.selected && state.sessionId && sessionKey(state.selected) === state.sessionId) {
    merged.set(state.selected.run_id, state.selected);
  }
  return [...merged.values()].sort((left, right) =>
    left.created_at.localeCompare(right.created_at),
  );
}

function messageRow(role, content, timestamp, pending = false, attachments = []) {
  const row = document.createElement("article");
  row.className = `message-row ${role}${pending ? " pending" : ""}`;
  row.innerHTML = `
    <span class="message-avatar"><i data-lucide="${role === "user" ? "user-round" : "bot"}"></i></span>
    <span class="message-copy">
      <span class="message-meta">
        <strong>${role === "user" ? "你" : "PI Agent"}</strong>
        <time>${escapeHtml(timestamp ? formatTime(timestamp) : "")}</time>
      </span>
      <p class="message-text"></p>
    </span>
  `;
  row.querySelector(".message-text").textContent = content;
  if (attachments.length) {
    const files = document.createElement("span");
    files.className = "message-attachments";
    files.textContent = attachments.map((item) => item.name).join(" · ");
    row.querySelector(".message-copy").append(files);
  }
  return row;
}

function renderConversation() {
  const runs = runsInCurrentSession();
  const first = runs[0] || null;
  el.sessionTitle.textContent = first ? truncate(runTitle(first), 72) : "新对话";
  el.sessionIdLabel.textContent = state.sessionId || "尚未创建";
  el.sessionRunCount.textContent = `${runs.length} runs`;
  el.conversationThread.querySelectorAll(".conversation-turn").forEach((node) => node.remove());
  el.conversationEmpty.hidden = runs.length > 0;
  for (const run of runs) {
    const turn = document.createElement("section");
    turn.className = "conversation-turn";
    turn.append(messageRow(
      "user",
      run.input || "请分析附件",
      run.created_at,
      false,
      run.attachments || [],
    ));
    if (run.status === "completed") {
      turn.append(messageRow("assistant", run.output || "", run.finished_at));
    } else if (run.status === "failed") {
      turn.append(messageRow("assistant", run.error_message || "运行失败", run.finished_at, true));
    } else {
      turn.append(messageRow(
        "assistant",
        run.output ||
          (run.status === "queued" ? "已进入队列，等待执行…" : "Agent 正在处理…"),
        run.created_at,
        true,
      ));
    }
    el.conversationThread.append(turn);
  }
  window.lucide?.createIcons();
  el.conversationThread.scrollTop = el.conversationThread.scrollHeight;
}

async function loadRuns(preferredId) {
  try {
    const data = await request("/v1/runs?limit=50");
    state.runs = data.items || [];
    renderSessionList();
    if (preferredId) {
      await selectRun(preferredId);
      return;
    }
    if (state.sessionId) {
      const latest = state.runs.find((run) => sessionKey(run) === state.sessionId);
      if (latest) {
        await selectRun(latest.run_id);
        return;
      }
    }
    if (state.runs[0]) await selectRun(state.runs[0].run_id);
    else resetConversation();
  } catch (error) {
    showError(error);
  }
}

async function selectRun(runId) {
  clearLiveUpdates();
  try {
    const [run, eventData] = await Promise.all([
      request(`/v1/runs/${encodeURIComponent(runId)}`),
      request(`/v1/runs/${encodeURIComponent(runId)}/events?format=json`)
        .catch(() => ({ items: [] })),
    ]);
    state.selected = run;
    state.sessionId = sessionKey(run);
    state.events = eventData.items || [];
    renderSessionList();
    renderConversation();
    renderRun();
    if (run.status === "queued" || run.status === "running") {
      openEventStream(run.run_id);
    }
  } catch (error) {
    showError(error);
  }
}

function renderRun() {
  const run = state.selected;
  el.empty.hidden = Boolean(run);
  el.content.hidden = !run;
  if (!run) return;
  if (run.status === "completed" || run.status === "failed") setRunning(false);
  el.metricStatus.textContent = run.status;
  el.metricDuration.textContent = formatDuration(run.duration_ms);
  el.metricTokens.textContent = formatTokens(run);
  el.metricModel.textContent = run.resolved_model || run.model || "-";
  el.response.textContent = run.output || "运行尚未产生输出。";
  el.raw.textContent = JSON.stringify(run, null, 2);
  el.eventCount.textContent = String(state.events.length);
  renderEvents();
  renderInspector();
}

function renderEvents() {
  el.events.replaceChildren();
  if (!state.events.length) {
    const note = document.createElement("p");
    note.className = "empty-list-note";
    note.textContent = "暂无事件";
    el.events.append(note);
    return;
  }
  for (const event of [...state.events].reverse()) {
    const row = document.createElement("article");
    row.className = "event-row";
    row.innerHTML = `
      <span class="event-seq">#${escapeHtml(String(event.seq))} · ${escapeHtml(formatTime(event.timestamp))}</span>
      <span class="event-content">
        <strong>${escapeHtml(event.event)}</strong>
        <small>${escapeHtml(JSON.stringify(event.details || {}))}</small>
      </span>
    `;
    el.events.append(row);
  }
}

function renderKv(container, rows) {
  container.replaceChildren();
  for (const [label, value, copy] of rows) {
    const row = document.createElement("dl");
    row.className = "kv-row";
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (copy) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-button";
      button.textContent = String(value || "-");
      button.title = "点击复制";
      button.addEventListener("click", async () => {
        await navigator.clipboard.writeText(String(value || ""));
        button.textContent = "已复制";
        setTimeout(() => {
          button.textContent = String(value || "-");
        }, 900);
      });
      dd.append(button);
    } else {
      dd.textContent = String(value ?? "-");
    }
    row.append(dt, dd);
    container.append(row);
  }
}

function renderInspector() {
  const run = state.selected;
  renderPlan(run);
  if (!run) {
    renderKv(el.idList, [["session", state.sessionId || "-"]]);
    renderKv(el.runInfo, [["状态", "等待首轮消息"]]);
    return;
  }
  renderKv(el.idList, [
    ["session_id", run.session_id, true],
    ["run_id", run.run_id, true],
    ["request_id", run.request_id, true],
    ["trace_id", run.trace_id, true],
    ["model_call", run.model_call_id || "-", Boolean(run.model_call_id)],
  ]);
  renderKv(el.runInfo, [
    ["tenant", run.tenant],
    ["intent", run.task_mode ? "task" : "chat"],
    ["sync/async", run.async_mode ? "async" : "sync"],
    ["status", run.status],
    ["model", run.resolved_model || run.model],
    ["release", run.release_id],
    ["created", formatTime(run.created_at)],
    ["started", formatTime(run.started_at)],
    ["finished", formatTime(run.finished_at)],
    ["duration", formatDuration(run.duration_ms)],
    ["prompt tok", run.prompt_tokens ?? "-"],
    ["output tok", run.completion_tokens ?? "-"],
    ["total tok", run.total_tokens ?? "-"],
    ["loop turns", run.loop_turns ?? "-"],
    ["tool calls", run.tool_calls_total ?? 0],
    ["tools used", run.tools_used?.join(", ") || "-"],
    ["skills used", run.skills_used?.join(", ") || "-"],
    ["attachments", (run.attachments || []).map((item) => item.name).join(", ") || "-"],
  ]);
}

function renderPlan(run) {
  const plan = Array.isArray(run?.plan) ? run.plan : [];
  el.planSection.hidden = plan.length === 0;
  el.planList.replaceChildren();
  for (const item of plan) {
    const row = document.createElement("div");
    const status = ["pending", "in_progress", "completed"].includes(item.status)
      ? item.status
      : "pending";
    row.className = `plan-item ${status}`;
    const marker = document.createElement("span");
    marker.className = "plan-marker";
    const text = document.createElement("span");
    text.textContent = item.step || "";
    row.append(marker, text);
    el.planList.append(row);
  }
}

function setExecutionMode(mode) {
  state.executionMode = mode;
  document.querySelectorAll(".mode-option").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setIntentMode(mode) {
  state.intentMode = mode;
  document.querySelectorAll(".intent-option").forEach((button) => {
    const active = button.dataset.intent === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setRunning(running) {
  el.submit.disabled = running;
  el.submitLabel.textContent = running ? "处理中…" : "发送消息";
  el.live.hidden = !running;
}

async function submitRun(event) {
  event.preventDefault();
  clearError();
  const input = el.input.value.trim();
  if (!input && state.attachments.length === 0) {
    showError(new Error("请输入消息，或添加文件/网页附件"));
    return;
  }
  if (!el.form.reportValidity()) return;

  const requestId = currentRequestId();
  const sessionId = state.sessionId || createSessionId();
  const tenant = el.tenant.value.trim();
  const pendingAttachments = [...state.attachments];
  const optimistic = {
    run_id: `pending-${Date.now()}`,
    session_id: sessionId,
    request_id: requestId,
    trace_id: "",
    model_call_id: null,
    tenant,
    input,
    model: state.health?.model || "deepseek-flash",
    resolved_model: null,
    release_id: state.health?.release_id || "",
    status: "running",
    task_mode: state.intentMode === "task",
    async_mode: state.executionMode !== "sync",
    output: null,
    error_code: null,
    error_message: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    duration_ms: null,
    gateway_request_id: null,
    usage_available: false,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    attachments: pendingAttachments.map((item) => ({
      name: item.name,
      source: item.url || item.name,
      kind: item.url ? "web" : "text",
      chars: 0,
      original_bytes: 0,
      truncated: false,
      stored_as: null,
    })),
  };

  state.sessionId = sessionId;
  state.selected = optimistic;
  state.runs = [optimistic, ...state.runs];
  state.events = [];
  setRunning(true);
  renderSessionList();
  renderConversation();
  renderRun();
  el.input.value = "";
  state.attachments = [];
  renderAttachments();

  try {
    const run = await request("/v1/runs", {
      method: "POST",
      headers: { "X-Request-ID": requestId },
      body: JSON.stringify({
        input,
        tenant,
        session_id: sessionId,
        async: state.executionMode !== "sync",
        task_mode: state.intentMode === "task",
        attachments: pendingAttachments.map(({ id: _id, display: _display, ...item }) => item),
      }),
    });
    state.runs = state.runs.filter((item) => item.run_id !== optimistic.run_id);
    state.selected = run;
    state.sessionId = sessionKey(run);
    state.runs = [run, ...state.runs.filter((item) => item.run_id !== run.run_id)];
    renderSessionList();
    renderConversation();
    renderRun();
    if (run.status === "queued" || run.status === "running") {
      openEventStream(run.run_id);
    } else {
      setRunning(false);
      void loadRuns(run.run_id);
    }
    refreshRequestTemplate();
  } catch (error) {
    state.runs = state.runs.filter((item) => item.run_id !== optimistic.run_id);
    state.selected = null;
    state.attachments = pendingAttachments;
    setRunning(false);
    renderSessionList();
    renderConversation();
    renderRun();
    renderAttachments();
    showError(error);
  }
}

function clearLiveUpdates() {
  state.eventSource?.close();
  state.eventSource = null;
  clearTimeout(state.pollTimer);
  state.pollTimer = 0;
}

function applyLiveRun(run) {
  state.selected = run;
  state.runs = state.runs.map((item) => item.run_id === run.run_id ? run : item);
  if (!state.runs.some((item) => item.run_id === run.run_id)) state.runs.unshift(run);
  renderSessionList();
  renderConversation();
  renderRun();
}

function openEventStream(runId) {
  clearLiveUpdates();
  setRunning(true);
  const source = new EventSource(`/v1/runs/${encodeURIComponent(runId)}/events`);
  state.eventSource = source;
  source.addEventListener("state", (event) => {
    const run = JSON.parse(event.data);
    applyLiveRun(run);
    if (run.status === "completed" || run.status === "failed") {
      source.close();
      state.eventSource = null;
      setRunning(false);
      void reloadRun(runId);
    }
  });
  source.addEventListener("token", (event) => {
    const data = JSON.parse(event.data);
    const current = state.selected;
    if (!current || current.run_id !== runId) return;
    applyLiveRun({
      ...current,
      status: "running",
      output: data.full_text || data.text || "",
    });
  });
  source.addEventListener("trace", (event) => {
    try {
      const data = JSON.parse(event.data);
      state.events.push({
        seq: state.events.length + 1,
        event: data.event,
        timestamp: new Date().toISOString(),
        details: data.details || {},
      });
      el.eventCount.textContent = String(state.events.length);
      renderEvents();
    } catch {
      // State frames still drive the run when a trace frame is malformed.
    }
  });
  source.addEventListener("done", () => {
    source.close();
    state.eventSource = null;
    setRunning(false);
    void reloadRun(runId);
  });
  source.onerror = () => {
    source.close();
    state.eventSource = null;
    state.pollTimer = window.setTimeout(() => void pollRun(runId), 800);
  };
}

async function pollRun(runId) {
  try {
    const run = await request(`/v1/runs/${encodeURIComponent(runId)}`);
    applyLiveRun(run);
    if (run.status === "completed" || run.status === "failed") {
      setRunning(false);
      await reloadRun(runId);
      return;
    }
    state.pollTimer = window.setTimeout(() => void pollRun(runId), 800);
  } catch (error) {
    setRunning(false);
    showError(error);
  }
}

async function reloadRun(runId) {
  const [run, eventData] = await Promise.all([
    request(`/v1/runs/${encodeURIComponent(runId)}`),
    request(`/v1/runs/${encodeURIComponent(runId)}/events?format=json`)
      .catch(() => ({ items: [] })),
  ]);
  state.selected = run;
  state.sessionId = sessionKey(run);
  state.events = eventData.items || [];
  applyLiveRun(run);
  renderEvents();
}

function setTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  document.querySelector("#view-response").hidden = tab !== "response";
  document.querySelector("#view-events").hidden = tab !== "events";
  document.querySelector("#view-raw").hidden = tab !== "raw";
}

function closeSidebar() {
  el.shell.classList.remove("sidebar-open");
}

function resetConversation() {
  clearLiveUpdates();
  state.selected = null;
  state.sessionId = null;
  state.attachments = [];
  renderAttachments();
  state.events = [];
  setRunning(false);
  renderSessionList();
  renderConversation();
  renderRun();
  setTab("response");
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("agentcompose-theme", theme);
  el.themeButton.innerHTML = `<i data-lucide="${theme === "dark" ? "sun" : "moon"}"></i>`;
  window.lucide?.createIcons();
}

function setupMonitoringLinks() {
  if (!el.grafanaLink || !el.prometheusLink) return;
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") return;
  el.grafanaLink.href =
    `http://${location.hostname}:8765/d/agentcompose-overview/agentcompose-overview?from=now-15m&to=now`;
  el.prometheusLink.href = `http://${location.hostname}:9090`;
}

el.form.addEventListener("submit", submitRun);
el.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    el.form.requestSubmit();
  }
});
el.filePickerButton.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", () => {
  void addFiles([...el.fileInput.files]);
});
el.webUrlAdd.addEventListener("click", addWebAttachment);
el.webUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addWebAttachment();
  }
});
document.querySelectorAll(".mode-option").forEach((button) => {
  button.addEventListener("click", () => setExecutionMode(button.dataset.mode));
});
document.querySelectorAll(".intent-option").forEach((button) => {
  button.addEventListener("click", () => setIntentMode(button.dataset.intent));
});
document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => setTab(button.dataset.tab));
});
el.runSearch.addEventListener("input", () => {
  state.query = el.runSearch.value.trim();
  renderSessionList();
});
el.newRun.addEventListener("click", () => {
  resetConversation();
  refreshRequestTemplate();
  closeSidebar();
  el.input.focus();
});
el.menuButton.addEventListener("click", () => el.shell.classList.add("sidebar-open"));
el.scrim.addEventListener("click", closeSidebar);
el.inspectorButton.addEventListener("click", () => {
  el.shell.classList.toggle("inspector-closed");
});
el.inspectorClose.addEventListener("click", () => el.shell.classList.add("inspector-closed"));
el.errorClose.addEventListener("click", clearError);
el.themeButton.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    el.newRun.click();
  }
});

applyTheme(localStorage.getItem("agentcompose-theme") || "dark");
renderAttachments();
setupMonitoringLinks();
refreshRequestTemplate();
setExecutionMode("stream");
setIntentMode("chat");
setTab("response");
if (window.innerWidth <= 1180) el.shell.classList.add("inspector-closed");
window.lucide?.createIcons();
resetConversation();

void loadHealth();
void loadCapabilities();
void loadRuns();
setInterval(() => void loadHealth(), 15_000);
