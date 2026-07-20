const state = {
  ranges: [],
  rangeNames: [],
  enabledRanges: [],
  rangeHosts: [],
  miners: [],
  minerTotal: 0,
  minerSummary: { total: 0, mining: 0, issues: 0, hashrate_value: 0, hashrate_unit: "", wattage: 0, average_temperature: null },
  ipReports: { running: false, error: null, miners: [] },
  ipReportRefreshing: false,
  statusSocket: null,
  statusSocketPath: "",
  statusReconnectTimer: null,
  selected: new Set(),
  sort: { key: "ip", direction: "asc" },
  table: { page: 1, pageSize: 10 },
  page: "miners",
  pendingAction: null,
  pendingActionMiners: null,
  actionSubmitting: false,
  history: { ip: null, miner: null, points: [] },
  charts: {},
  chartHovering: {},
  chartPending: {},
  activeStatePopover: null,
  settings: {
    scan_interval: 30,
    scan_concurrency_limit: 1000,
    data_update_interval: 30,
    background_data_concurrency_limit: 250,
    auto_clear_offline: false,
    appearance: "system",
  },
  settingsDirty: false,
  rangesPending: false,
  rangeSearch: "",
  rangePreviewRequest: 0,
  nextScanAtMs: null,
  nextDataAtMs: null,
  schedule: { liveScanning: false, liveDataUpdates: false, hasRanges: false, scanRunning: false, dataUpdateRunning: false },
  scanProgress: { total: 0, scanned: 0, found: 0, current_ip: null },
  scanProgressComplete: false,
  scanProgressTimer: null,
  scanProgressResetting: false,
  scanProgressResetFrame: null,
  appliedAppearance: null,
  chartThemeKey: null,
  chartDebug: {},
};

const pages = {
  ranges: ["IP Ranges", "Add octet ranges using a-b.c-d.e-f.g-h notation."],
  ipReports: ["Listener", "Listen for miner IP reports and identify reporting devices."],
  miners: ["Home", "Sort, select, inspect status, and apply supported actions."],
  settings: ["Settings", "Configure automatic scanning and table cleanup."],
  history: ["Miner History", "Recent operating data for the selected miner."],
};

const actionDefs = [
  { id: "restart", label: "Restart", flag: "supports_restart", fields: [] },
  { id: "pause", label: "Pause mining", flag: "supports_pause", fields: [] },
  { id: "resume", label: "Resume mining", flag: "supports_resume", fields: [] },
  { id: "fault_light", label: "Fault light", flag: "supports_set_fault_light", fields: [{ name: "enabled", label: "Enabled", type: "checkbox" }] },
  { id: "power_limit", label: "Power limit", flag: "supports_set_power_limit", fields: [{ name: "watts", label: "Watts", type: "number", min: 1 }] },
  { id: "tuning_percent", label: "Tuning percent", flag: "supports_set_tuning_percent", fields: [{ name: "percent", label: "Percent", type: "number", min: 1, max: 200 }] },
  { id: "fan_manual", label: "Fan manual", flag: "supports_fan_config", fields: [{ name: "speed", label: "Fan speed %", type: "number", min: 0, max: 100 }] },
  { id: "fan_auto", label: "Fan auto", flag: "supports_fan_config", fields: [{ name: "target_temp", label: "Target temp", type: "number" }, { name: "idle_speed", label: "Idle speed %", type: "number", min: 0, max: 100 }] },
  { id: "tuning_power", label: "Tuning power", flag: "supports_tuning_config", fields: [{ name: "watts", label: "Watts", type: "number", min: 1 }] },
  { id: "tuning_hashrate", label: "Tuning hashrate", flag: "supports_tuning_config", fields: [{ name: "hashrate", label: "Hashrate", type: "number", min: 1 }] },
  { id: "tuning_mode", label: "Tuning mode", flag: "supports_tuning_config", fields: [{ name: "mode", label: "Mode", type: "select", options: ["Low", "Normal", "High"] }] },
  { id: "scaling", label: "Scaling", flag: "supports_scaling_config", fields: [{ name: "step", label: "Step", type: "number" }, { name: "minimum", label: "Minimum", type: "number" }, { name: "shutdown", label: "Shutdown", type: "checkbox" }, { name: "shutdown_duration", label: "Shutdown duration", type: "number" }] },
  { id: "pools", label: "Pools", flag: "supports_pools_config", custom: "pools" },
];

const actionGroups = [
  { id: "restart", label: "Restart", actions: ["restart"] },
  { id: "mining_state", label: "Mining State", actions: ["pause", "resume"] },
  { id: "fault_light", label: "Fault Light", actions: ["fault_light"] },
  { id: "fan_mode", label: "Fan Mode", actions: ["fan_manual", "fan_auto"] },
  { id: "tuning", label: "Tuning", actions: ["tuning_power", "tuning_hashrate", "tuning_mode"] },
  { id: "scaling", label: "Scaling", actions: ["scaling"] },
  { id: "pools", label: "Pools", actions: ["pools"] },
];

const $ = (id) => document.getElementById(id);

window.addEventListener("error", (event) => {
  reportClientError({
    kind: "error",
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  reportClientError({
    kind: "unhandledrejection",
    message: errorMessage(event.reason),
    stack: event.reason?.stack,
  });
});

function reportClientError(payload) {
  const body = {
    ...payload,
    page: state.page,
    historyIp: state.history.ip,
    historyPoints: state.history.points.length,
    charts: state.chartDebug,
    userAgent: navigator.userAgent,
    location: window.location.href,
  };
  console.error("Client diagnostic", body);
  fetch("/api/client-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  return error.message || String(error);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.error || data.detail) throw new Error(data.error || data.detail || response.statusText);
  return data;
}

function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3600);
}

function showPage(page) {
  hideStatePopover();
  if (state.page === "history" && page !== "history") destroyHistoryCharts();
  state.page = page;
  document.querySelectorAll(".page").forEach((el) => el.classList.toggle("active", el.id === page));
  document.querySelectorAll(".nav").forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $("pageTitle").textContent = pages[page].at(0);
  $("pageSubtitle").textContent = pages[page].at(1);
  renderSelectionBar();
  if (page !== "history") $("minerActionBar").hidden = true;
  if (page === "ipReports") refreshIpReports().catch((error) => toast(error.message));
}

async function refresh(expectedPath = statusPath()) {
  const data = await api(expectedPath);
  if (expectedPath !== statusPath()) return;
  applyStatus(data);
}

function statusParams() {
  return new URLSearchParams({
    page: String(state.table.page),
    page_size: String(state.table.pageSize),
    sort_key: state.sort.key,
    sort_direction: state.sort.direction,
  });
}

function statusPath() {
  return `/api/status?${statusParams()}`;
}

function statusStreamPath() {
  return `/api/status-stream?${statusParams()}`;
}

async function reloadMinerPage() {
  connectStatusStream();
  await refresh();
}

function applyStatus(data) {
  const wasScanRunning = state.schedule.scanRunning;
  const nextScanRunning = !!data.scan_running;
  if (!state.rangesPending && !isEditingRange()) {
    state.ranges = data.ranges || [];
    state.rangeNames = normalizeRangeNames(data.range_names || [], state.ranges);
    state.enabledRanges = normalizeEnabledRanges(data.enabled_ranges || [], state.ranges);
    state.rangeHosts = normalizeRangeHosts(data.range_hosts || [], state.ranges);
  }
  state.miners = data.miners || [];
  state.minerSummary = data.miner_summary || state.minerSummary;
  state.minerTotal = data.miner_page?.total ?? state.miners.length;
  if (data.miner_page) {
    state.table.page = data.miner_page.page || state.table.page;
    state.table.pageSize = data.miner_page.page_size || state.table.pageSize;
    state.sort.key = data.miner_page.sort_key || state.sort.key;
    state.sort.direction = data.miner_page.sort_direction || state.sort.direction;
  }
  if (state.history.ip) {
    const activeMiner = state.miners.find((miner) => miner.ip === state.history.ip);
    if (activeMiner) state.history.miner = activeMiner;
  }
  clampTablePage(state.minerTotal);
  const historyChanged = mergeActiveHistoryPoint();
  if (!state.settingsDirty) state.settings = data.settings || state.settings;
  if (state.appliedAppearance !== state.settings.appearance) applyAppearance(state.settings.appearance);
  state.selected = new Set([...state.selected].filter((ip) => state.miners.some((miner) => miner.ip === ip)));
  updateScanProgressState(data.scan_progress, wasScanRunning, nextScanRunning);
  updateScheduleState(data);
  renderAll({ updateHistoryCharts: historyChanged });
  if (data.last_scan_error) toast(data.last_scan_error);
}

function updateScanProgressState(progress, wasScanRunning, nextScanRunning) {
  const incoming = progress || { total: 0, scanned: 0, found: 0, current_ip: null };
  if (!wasScanRunning && nextScanRunning) {
    clearScanProgressTimer();
    state.scanProgressComplete = false;
    state.scanProgressResetting = true;
    state.scanProgress = { ...incoming, scanned: 0, found: 0, current_ip: null };
    return;
  }

  state.scanProgress = incoming;
  if (wasScanRunning && !nextScanRunning) {
    clearScanProgressTimer();
    state.scanProgressComplete = true;
    state.scanProgressTimer = setTimeout(() => {
      state.scanProgressComplete = false;
      state.scanProgressTimer = null;
      renderScanProgress();
    }, 1000);
  }
}

function clearScanProgressTimer() {
  if (!state.scanProgressTimer) return;
  clearTimeout(state.scanProgressTimer);
  state.scanProgressTimer = null;
}

function scheduleScanProgressReveal() {
  if (state.scanProgressResetFrame !== null) return;
  state.scanProgressResetFrame = requestAnimationFrame(() => {
    state.scanProgressResetting = false;
    state.scanProgressResetFrame = null;
    renderScanProgress();
  });
}

function mergeActiveHistoryPoint() {
  if (state.page !== "history" || !state.history.ip) return false;
  const miner = state.miners.find((item) => item.ip === state.history.ip);
  const point = miner?.latest_history;
  if (!point?.timestamp) return false;
  const last = state.history.points.at(-1);
  if (last && Number(last.timestamp) === Number(point.timestamp)) {
    if (JSON.stringify(last) === JSON.stringify(point)) return false;
    state.history.points[state.history.points.length - 1] = point;
  } else if (!last || Number(point.timestamp) > Number(last.timestamp)) {
    state.history.points.push(point);
    trimClientHistory();
  } else {
    return false;
  }
  state.history.miner = miner;
  return true;
}

function trimClientHistory() {
  const cutoff = Date.now() / 1000 - 30 * 60;
  state.history.points = state.history.points.filter((point) => Number(point.timestamp) >= cutoff);
}

function updateScheduleState(data) {
  const now = Date.now();
  state.nextScanAtMs = Number.isFinite(data.next_scan_in) ? now + data.next_scan_in * 1000 : null;
  state.nextDataAtMs = Number.isFinite(data.next_data_update_in) ? now + data.next_data_update_in * 1000 : null;
  state.schedule = {
    liveScanning: !!data.live_scanning,
    liveDataUpdates: !!data.live_data_updates,
    hasRanges: normalizeEnabledRanges(data.enabled_ranges || [], data.ranges || []).some(Boolean),
    scanRunning: !!data.scan_running,
    dataUpdateRunning: !!data.data_update_running,
  };
  renderSchedule();
}

function renderAll({ updateHistoryCharts = true } = {}) {
  if (!state.rangesPending && !isEditingRange()) renderRanges();
  renderSettings();
  renderHomeStats();
  renderTable();
  renderIpReports();
  if (state.page === "history" && state.history.ip) renderHistory({ updateCharts: updateHistoryCharts });
  renderSelectionBar();
  renderSchedule();
  renderScanProgress();
}

function renderSchedule() {
  const scanButton = $("liveScanToggle");
  const dataButton = $("liveDataToggle");
  const scanDue = scheduleDue(state.schedule.liveScanning, state.schedule.hasRanges, state.schedule.scanRunning, state.nextScanAtMs);
  const dataDue = scheduleDue(state.schedule.liveDataUpdates, true, state.schedule.dataUpdateRunning, state.nextDataAtMs);
  scanButton.textContent = `Scan ${scheduleText({
    live: state.schedule.liveScanning,
    ready: state.schedule.hasRanges,
    deadline: state.nextScanAtMs,
    active: state.schedule.scanRunning,
    waitingText: "Add range",
  })}`;
  dataButton.textContent = `Data ${scheduleText({
    live: state.schedule.liveDataUpdates,
    ready: true,
    deadline: state.nextDataAtMs,
    active: state.schedule.dataUpdateRunning,
    waitingText: "Waiting",
  })}`;
  scanButton.classList.toggle("active", state.schedule.liveScanning);
  scanButton.classList.toggle("running", state.schedule.scanRunning || scanDue);
  scanButton.setAttribute("aria-pressed", String(state.schedule.liveScanning));
  dataButton.classList.toggle("active", state.schedule.liveDataUpdates);
  dataButton.classList.toggle("running", state.schedule.dataUpdateRunning || dataDue);
  dataButton.setAttribute("aria-pressed", String(state.schedule.liveDataUpdates));
}

function renderScanProgress() {
  const progress = state.scanProgress || {};
  const total = Number(progress.total) || 0;
  const scanned = Number(progress.scanned) || 0;
  const found = Number(progress.found) || 0;
  const percent = total > 0 ? Math.max(0, Math.min(100, (scanned / total) * 100)) : 0;
  const bar = $("scanProgress");
  const visible = state.schedule.scanRunning || state.scanProgressComplete;
  bar.hidden = !visible;
  bar.classList.toggle("complete", state.scanProgressComplete);
  bar.classList.toggle("resetting", state.scanProgressResetting);
  $("scanProgressCount").textContent = state.scanProgressComplete
    ? "Complete"
    : total > 0 ? `${number(scanned)} / ${number(total)}` : `${number(scanned)}`;
  $("scanProgressDetail").textContent = `${number(found)} found`;
  $("scanProgressFill").style.width = !visible || state.scanProgressResetting ? "0%" : state.scanProgressComplete ? "100%" : total > 0 ? `${percent}%` : "100%";
  $("scanProgressFill").classList.toggle("indeterminate", visible && !state.scanProgressResetting && !state.scanProgressComplete && total === 0);
  if (state.scanProgressResetting) scheduleScanProgressReveal();
}

function scheduleText({ live, ready, deadline, active = false, waitingText }) {
  if (active) return "now";
  if (!live) return "off";
  if (!ready) return waitingText;
  if (!deadline) return waitingText;
  const seconds = Math.ceil((deadline - Date.now()) / 1000);
  if (seconds <= 0) return "now";
  return `in ${formatDuration(seconds)}`;
}

function scheduleDue(live, ready, active, deadline) {
  return live && ready && !active && deadline && deadline <= Date.now();
}

function formatDuration(totalSeconds) {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

function minerErrors(miner) {
  const messages = miner.data?.messages || [];
  const severityErrors = messages.filter((message) => message.severity === "Error").length;
  return (miner.error ? 1 : 0) + severityErrors;
}

function minerState(miner) {
  if (miner.loading) return { label: "Loading", className: "loading", order: 1 };
  if (miner.error) return { label: "Offline", className: "offline", order: 0 };
  const hasData = miner.data && Object.keys(miner.data).length > 0;
  if (!hasData || !miner.last_seen) return { label: "Offline", className: "offline", order: 0 };
  if (miner.data?.is_mining === false) return { label: "Paused", className: "paused", order: 1 };
  const errors = minerErrors(miner);
  if (errors) return { label: `${errors} issue${errors === 1 ? "" : "s"}`, className: "err", order: 2 };
  const warnings = (miner.data?.messages || []).filter((message) => message.severity === "Warning").length;
  if (warnings) return { label: `${warnings} warning${warnings === 1 ? "" : "s"}`, className: "warn", order: 3 };
  if (miner.data?.is_mining === true) return { label: "Mining", className: "ok", order: 4 };
  return { label: "Unknown", className: "", order: 1 };
}

function hasCurrentMinerData(miner) {
  return !!miner && !miner.loading && !miner.error && !!miner.last_seen;
}

function getDeviceInfo(miner) {
  return miner.data?.device_info || {};
}

function normalizeModel(value) {
  return String(value || "").replace(/plus/gi, "+").replace(/\s+\+/g, "+");
}

function getMake(miner) {
  return getDeviceInfo(miner).make || "-";
}

function getModel(miner) {
  const info = getDeviceInfo(miner);
  return normalizeModel(info.model) || "Unknown";
}

function getFirmware(miner) {
  const info = miner.data?.device_info || {};
  return info.firmware || info.firmware_version || info.version || miner.data?.firmware || miner.data?.firmware_version || "-";
}

function getHostname(miner) {
  return miner.data?.hostname || "-";
}

function getHashrate(miner) {
  const rate = miner.data?.hashrate;
  if (!rate) return "";
  return `${number(rate.value)} ${rate.unit || ""}`.trim();
}

function rateParts(rate) {
  if (!rate) return { value: "", unit: "" };
  if (typeof rate === "object") return { value: number(rate.value), unit: rate.unit || "" };
  return { value: number(rate), unit: "" };
}

function getHashratePair(miner) {
  const reported = rateParts(miner.data?.hashrate);
  const expected = rateParts(miner.data?.expected_hashrate);
  if (reported.value && expected.value && reported.unit === expected.unit) {
    return `${reported.value} / ${expected.value} ${reported.unit}`.trim();
  }
  const reportedText = `${reported.value} ${reported.unit}`.trim();
  const expectedText = `${expected.value} ${expected.unit}`.trim();
  if (reportedText && expectedText) return `${reportedText} / ${expectedText}`;
  return reportedText || expectedText;
}

function rateValue(rate) {
  if (!rate) return 0;
  if (typeof rate === "object") return numeric(rate.value);
  return numeric(rate);
}

function finiteValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getExpectedHashrate(miner) {
  const rate = miner.data?.expected_hashrate;
  if (!rate) return "";
  if (typeof rate === "object") return `${number(rate.value)} ${rate.unit || ""}`.trim();
  return number(rate);
}

function getExpectedHashrateValue(miner) {
  const value = rateValue(miner.data?.expected_hashrate);
  return value > 0 ? value : null;
}

function getEfficiency(miner) {
  const efficiency = miner.data?.efficiency;
  if (!efficiency) return "";
  if (typeof efficiency === "object") return `${number(efficiency.value)} ${efficiency.unit || ""}`.trim();
  return number(efficiency);
}

function getUptime(miner) {
  const uptime = miner.data?.uptime;
  if (!uptime) return "-";
  if (typeof uptime === "number") return duration(uptime);
  const text = String(uptime);
  const seconds = numericDuration(text);
  if (seconds > 0) return duration(seconds);
  const match = text.match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/);
  if (match) {
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    return duration(hours * 3600 + minutes * 60 + seconds);
  }
  return text.replace(/^PT/, "").toLowerCase();
}

function getChips(miner) {
  const working = miner.data?.working_chips ?? sum(miner.data?.hashboards, "working_chips");
  const total = miner.data?.total_chips ?? miner.data?.expected_chips ?? sum(miner.data?.hashboards, "expected_chips");
  if (hasValue(working) && hasValue(total)) return `${number(working)} / ${number(total)}`;
  if (hasValue(total)) return number(total);
  return "-";
}

function getBoards(miner) {
  const boards = miner.data?.hashboards || [];
  if (!Array.isArray(boards) || !boards.length) {
    return hasValue(miner.data?.expected_hashboards) ? `0 / ${number(miner.data.expected_hashboards)}` : "-";
  }
  const active = boards.filter((board) => board?.active !== false).length;
  const expected = miner.data?.expected_hashboards || boards.length;
  return `${number(active)} / ${number(expected)}`;
}

function getTuning(miner) {
  const percent = miner.data?.tuning_percent;
  const target = miner.data?.scaled_tuning_target || miner.data?.tuning_target;
  const targetText = tuningTargetText(target);
  if (hasValue(percent) && targetText) return `${number(percent)}% · ${targetText}`;
  if (hasValue(percent)) return `${number(percent)}%`;
  return targetText || "-";
}

function tuningTargetText(target) {
  if (!target) return "";
  if (typeof target === "string") return target;
  if (target.mode) return String(target.mode);
  if (target.wattage) return `${number(rateValue(target.wattage))} W`;
  if (target.watts) return `${number(rateValue(target.watts))} W`;
  if (target.hashrate) {
    const rate = target.hashrate;
    return typeof rate === "object" ? `${number(rate.value)} ${rate.unit || ""}`.trim() : number(rate);
  }
  return "";
}

function getTuningTargetWattage(miner) {
  return tuningTargetWattageValue(miner.data?.scaled_tuning_target) ?? tuningTargetWattageValue(miner.data?.tuning_target);
}

function tuningTargetWattageValue(target) {
  if (!target || typeof target !== "object") return null;
  const direct = finiteValue(target.wattage) ?? finiteValue(target.watts);
  if (direct !== null) return direct;
  const nested = rateValue(target.wattage || target.watts || target.power);
  if (nested > 0) return nested;
  const type = String(target.type || target.mode || target.kind || "").toLowerCase();
  if (type.includes("watt")) return finiteValue(target.value);
  return null;
}

function getFans(miner) {
  const fans = miner.data?.fans || miner.data?.fan_data || [];
  const psuFans = miner.data?.psu_fans || [];
  const allFans = [
    ...(Array.isArray(fans) ? fans : []),
    ...(Array.isArray(psuFans) ? psuFans : []),
  ];
  if (!allFans.length) return "-";
  const speeds = allFans
    .map((fan) => fan?.speed ?? fan?.rpm ?? fan?.value)
    .filter((value) => value !== undefined && value !== null && value !== "");
  if (!speeds.length) return `${allFans.length} fan${allFans.length === 1 ? "" : "s"}`;
  return speeds.map(number).join(" / ");
}

function getPool(miner) {
  const active = getActivePool(miner);
  return poolValue(active, ["url", "pool_url", "poolUrl", "stratum_url", "stratumUrl", "uri"]) || "-";
}

function getPoolUser(miner) {
  const active = getActivePool(miner);
  return poolValue(active, ["user", "username", "pool_user", "poolUser", "worker", "worker_name", "workerName"]) || "-";
}

function getActivePool(miner) {
  const pools = poolCandidates(miner);
  return pools.find(isActivePool) || pools[0] || null;
}

function poolCandidates(miner) {
  const sources = [
    miner.data?.pools,
    miner.data?.pool_data,
    miner.data?.poolData,
    miner.data?.active_pool,
    miner.data?.activePool,
  ];
  return sources.flatMap(flattenPools).filter((pool) => pool && typeof pool === "object");
}

function flattenPools(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenPools);
  if (typeof value !== "object") return [];
  const nested = [value.pools, value.pool_data, value.poolData].flatMap(flattenPools);
  return nested.length ? nested : [value];
}

function isActivePool(pool) {
  if (pool.active === true || pool.is_active === true || pool.current === true || pool.selected === true) return true;
  const status = String(pool.status || pool.state || pool.pool_status || "").toLowerCase();
  return ["active", "alive", "connected", "current", "working"].includes(status);
}

function poolValue(pool, keys) {
  if (!pool) return "";
  for (const key of keys) {
    const value = pool[key];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "";
}

function formatValue(value) {
  if (!hasValue(value)) return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return number(value);
  if (Array.isArray(value)) return value.length ? `${number(value.length)} item${value.length === 1 ? "" : "s"}` : "-";
  if (typeof value === "object") {
    if (hasValue(value.value)) return `${number(value.value)} ${value.unit || ""}`.trim();
    if (hasValue(value.mode)) return String(value.mode);
    if (hasValue(value.name)) return String(value.name);
    return Object.entries(value)
      .filter(([, item]) => hasValue(item) && typeof item !== "object")
      .slice(0, 3)
      .map(([key, item]) => `${titleize(key)}: ${formatValue(item)}`)
      .join(", ") || "-";
  }
  return String(value);
}

function titleize(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function valueByPath(source, path) {
  return path.split(".").reduce((value, key) => value?.[key], source);
}

function firstPresent(...values) {
  return values.find((value) => hasValue(value));
}

function minerIp(miner) {
  return firstPresent(
    miner?.ip,
    miner?.data?.ip,
    miner?.data?.ip_address,
    miner?.data?.ipAddress,
    miner?.data?.network?.ip,
    miner?.data?.network?.ip_address,
    miner?.data?.network_info?.ip,
    miner?.data?.network_info?.ip_address,
    miner?.data?.networkInfo?.ip,
    miner?.data?.networkInfo?.ipAddress,
    state.history.ip,
  ) || "-";
}

function formatDetailValue(label, value) {
  if (!hasValue(value)) return "-";
  if (isTimestampLabel(label)) {
    const date = readableDateTime(value);
    if (date) return date;
  }
  const unit = unitForLabel(label);
  if (unit && finiteValue(value) !== null) {
    return `${number(value)} ${unit}`;
  }
  if (typeof value === "number") {
    return number(value);
  }
  return formatValue(value);
}

function isTimestampLabel(label) {
  const text = String(label || "").toLowerCase();
  return ["time", "timestamp", "date", "seen"].some((term) => text.includes(term));
}

function readableDateTime(value) {
  const raw = typeof value === "object" && value !== null && hasValue(value.value) ? value.value : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return "";
  const milliseconds = parsed > 1e12 ? parsed : parsed > 1e9 ? parsed * 1000 : null;
  if (!milliseconds) return "";
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function unitForLabel(label) {
  const text = String(label || "").toLowerCase();
  if (text.includes("temperature") || text === "temp" || text.endsWith(" temp")) return "°C";
  if (text.includes("watt") || text.includes("power")) return "W";
  if (text.includes("efficiency")) return "J/TH";
  if (text.includes("percent")) return "%";
  if (text.includes("rpm")) return "RPM";
  if (text.includes("voltage") || text.includes("volt")) return "V";
  if (text.includes("current") || text.includes("amp")) return "A";
  if (text.includes("frequency") || text.includes("freq")) return "MHz";
  return "";
}

function number(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function sum(items, key) {
  if (!Array.isArray(items)) return null;
  const values = items.map((item) => Number(item?.[key])).filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function duration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds)));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function numericDuration(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  const text = String(value);
  const iso = text.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso) {
    return Number(iso[1] || 0) * 86400 + Number(iso[2] || 0) * 3600 + Number(iso[3] || 0) * 60 + Number(iso[4] || 0);
  }
  const match = text.match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function renderHomeStats() {
  const summary = state.minerSummary || {};
  const totalWatts = numeric(summary.wattage);
  const averageTemperature = numeric(summary.average_temperature);
  const hashrate = numeric(summary.hashrate_value);
  const unit = summary.hashrate_unit || "";
  const mining = numeric(summary.mining);
  const issues = numeric(summary.issues);
  $("homeStats").innerHTML = [
    metricCard("Miners", number(summary.total ?? state.minerTotal), `${number(mining)} mining`),
    metricCard("Issues", number(issues), issues ? "Needs attention" : "No active issues"),
    metricCard("Hashrate", hashrate ? `${number(hashrate)} ${unit}`.trim() : "-", "Reported total"),
    metricCard("Power", totalWatts ? `${number(totalWatts)} W` : "-", "Reported draw"),
    metricCard("Average Temperature", averageTemperature ? `${number(averageTemperature)} °C` : "-", "Online miners"),
  ].join("");
}

function metricCard(label, value, detail) {
  return `
    <div class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderRanges() {
  $("rangeSearchInput").value = state.rangeSearch;
  if (!state.ranges.length) {
    $("rangeList").innerHTML = "";
    return;
  }
  const rows = filteredRangeRows();
  if (!rows.length) {
    $("rangeList").innerHTML = `<div class="range-empty">No ranges match this search.</div>`;
    return;
  }
  $("rangeList").innerHTML = `
    <table class="range-table">
      <thead>
        <tr>
          <th class="range-order">Order</th>
          <th class="range-enabled">Enabled</th>
          <th>Name</th>
          <th>Range</th>
          <th class="range-hosts">Hosts</th>
          <th class="range-remove"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(({ range, name, index }) => `
          <tr class="${state.enabledRanges[index] ? "" : "off"}">
            <td class="range-order">
              <button class="icon-btn" data-move-range="${index}" data-move-direction="-1" ${index === 0 ? "disabled" : ""} aria-label="Move ${escapeHtml(name || range)} up" title="Move up">&#8593;</button>
              <button class="icon-btn" data-move-range="${index}" data-move-direction="1" ${index === state.ranges.length - 1 ? "disabled" : ""} aria-label="Move ${escapeHtml(name || range)} down" title="Move down">&#8595;</button>
            </td>
            <td class="range-enabled">
              <label class="switch range-switch" title="${state.enabledRanges[index] ? "Disable range" : "Enable range"}">
                <input type="checkbox" data-range-enabled="${index}" ${state.enabledRanges[index] ? "checked" : ""} />
                <i></i>
              </label>
            </td>
            <td class="range-name">
              <input class="range-edit-input" data-range-name-edit="${index}" value="${escapeHtml(name)}" spellcheck="false" aria-label="Edit name for ${escapeHtml(range)}" placeholder="Name" />
            </td>
            <td class="range-expression">
              <input class="range-edit-input" data-range-edit="${index}" value="${escapeHtml(range)}" spellcheck="false" aria-label="Edit range ${escapeHtml(range)}" />
            </td>
            <td class="range-hosts">${number(state.rangeHosts[index] ?? 0)}</td>
            <td class="range-remove">
              <button class="icon-btn danger" data-remove-range="${index}" aria-label="Remove ${escapeHtml(range)}" title="Remove range">&#128465;</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function filteredRangeRows() {
  const query = state.rangeSearch.trim().toLowerCase();
  return state.ranges
    .map((range, index) => ({
      range,
      name: state.rangeNames[index] || "",
      index,
    }))
    .filter(({ range, name }) => !query || range.toLowerCase().includes(query) || name.toLowerCase().includes(query));
}

async function persistRanges(message = "Ranges updated") {
  state.rangesPending = true;
  try {
    state.rangeNames = normalizeRangeNames(state.rangeNames, state.ranges);
    state.enabledRanges = normalizeEnabledRanges(state.enabledRanges, state.ranges);
    const data = await post("/api/ranges", { ranges: state.ranges, range_names: state.rangeNames, enabled_ranges: state.enabledRanges });
    state.ranges = data.ranges || [];
    state.rangeNames = normalizeRangeNames(data.range_names || [], state.ranges);
    state.enabledRanges = normalizeEnabledRanges(data.enabled_ranges || [], state.ranges);
    state.rangeHosts = normalizeRangeHosts(data.range_hosts || [], state.ranges);
    renderRanges();
    toast(message);
  } finally {
    state.rangesPending = false;
  }
}

function normalizeEnabledRanges(enabledRanges, ranges) {
  return ranges.map((_, index) => index < enabledRanges.length ? !!enabledRanges[index] : true);
}

function normalizeRangeNames(rangeNames, ranges) {
  return ranges.map((_, index) => index < rangeNames.length ? String(rangeNames[index] || "").trim() : "");
}

function normalizeRangeHosts(rangeHosts, ranges) {
  return ranges.map((_, index) => Number.isFinite(Number(rangeHosts[index])) ? Number(rangeHosts[index]) : 0);
}

function isEditingRange() {
  return document.activeElement instanceof HTMLElement && document.activeElement.matches("[data-range-edit], [data-range-name-edit], #rangeSearchInput");
}

function isEditingTablePager() {
  return document.activeElement instanceof HTMLElement && document.activeElement.id === "minerPageSize";
}

async function editRange(index, value) {
  const range = value.trim();
  if (range === state.ranges[index]) {
    renderRanges();
    return;
  }
  if (!range) {
    renderRanges();
    toast("Range expression is required");
    return;
  }
  const previous = snapshotRanges();
  state.ranges[index] = range;
  state.rangeHosts[index] = 0;
  renderRanges();
  try {
    await persistRanges("Range updated");
  } catch (error) {
    restoreRanges(previous);
    renderRanges();
    toast(error.message);
  }
}

async function editRangeName(index, value) {
  const name = value.trim();
  if (name === state.rangeNames[index]) {
    renderRanges();
    return;
  }
  const previous = [...state.rangeNames];
  state.rangeNames[index] = name;
  renderRanges();
  try {
    await persistRanges("Range name updated");
  } catch (error) {
    state.rangeNames = previous;
    renderRanges();
    toast(error.message);
  }
}

async function moveRange(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.ranges.length) return;
  const previous = snapshotRanges();
  swapItems(state.ranges, index, target);
  swapItems(state.rangeNames, index, target);
  swapItems(state.enabledRanges, index, target);
  swapItems(state.rangeHosts, index, target);
  renderRanges();
  try {
    await persistRanges("Range moved");
  } catch (error) {
    restoreRanges(previous);
    renderRanges();
    toast(error.message);
  }
}

function snapshotRanges() {
  return {
    ranges: [...state.ranges],
    rangeNames: [...state.rangeNames],
    enabledRanges: [...state.enabledRanges],
    rangeHosts: [...state.rangeHosts],
  };
}

function restoreRanges(snapshot) {
  state.ranges = snapshot.ranges;
  state.rangeNames = snapshot.rangeNames;
  state.enabledRanges = snapshot.enabledRanges;
  state.rangeHosts = snapshot.rangeHosts;
}

function swapItems(items, left, right) {
  [items[left], items[right]] = [items[right], items[left]];
}

function renderSettings(force = false) {
  if (state.settingsDirty && !force) return;
  $("scanIntervalInput").value = state.settings.scan_interval ?? 30;
  $("scanConcurrencyLimitInput").value = state.settings.scan_concurrency_limit ?? 1000;
  $("dataUpdateIntervalInput").value = state.settings.data_update_interval ?? 30;
  $("backgroundDataConcurrencyLimitInput").value = state.settings.background_data_concurrency_limit ?? 250;
  $("autoClearOfflineToggle").checked = !!state.settings.auto_clear_offline;
  $("appearanceSelect").value = state.settings.appearance || "system";
  applyAppearance($("appearanceSelect").value);
}

async function saveSettings() {
  const scanInterval = Number($("scanIntervalInput").value);
  const scanConcurrencyLimit = Number($("scanConcurrencyLimitInput").value);
  const dataUpdateInterval = Number($("dataUpdateIntervalInput").value);
  const backgroundDataConcurrencyLimit = Number($("backgroundDataConcurrencyLimitInput").value);
  const payload = {
    scan_interval: scanInterval,
    scan_concurrency_limit: scanConcurrencyLimit,
    data_update_interval: dataUpdateInterval,
    background_data_concurrency_limit: backgroundDataConcurrencyLimit,
    auto_clear_offline: $("autoClearOfflineToggle").checked,
    appearance: $("appearanceSelect").value,
  };
  const data = await post("/api/settings", payload);
  state.settings = data.settings || state.settings;
  state.settingsDirty = false;
  renderSettings(true);
  toast("Settings saved");
}

function applyAppearance(appearance = "system") {
  const mode = ["system", "light", "dark"].includes(appearance) ? appearance : "system";
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode === "system" ? "light dark" : mode;
  state.appliedAppearance = mode;
  updateFavicon(mode);
  updateChartThemes();
}

function updateFavicon(appearance = "system") {
  const favicon = $("favicon");
  if (!favicon) return;
  const mode = appearance === "system" ? resolvedThemeMode() : appearance;
  favicon.href = mode === "dark" ? "/assets/logo-mark-dark.svg" : "/assets/logo-mark-light.svg";
}

function updateChartThemes() {
  if (!Object.keys(state.charts).length) return;
  if (state.page !== "history" || !state.history.ip) return;
  renderHistory();
}

function destroyHistoryCharts() {
  Object.values(state.charts).forEach((chart) => chart.instance.destroy());
  state.charts = {};
  state.chartHovering = {};
  state.chartPending = {};
}

function renderTable({ forcePager = false } = {}) {
  const miners = sortedMiners();
  clampTablePage(state.minerTotal);
  const pageCount = tablePageCount(state.minerTotal);
  const pageMiners = currentPageMiners(miners);
  const tbody = $("minerRows");
  const activeStatusIp = state.activeStatePopover?.wrapper.closest("tr[data-open-history]")?.dataset.openHistory || null;
  updateSortHeaders();
  $("selectionCount").textContent = tableSummary(state.minerTotal, pageMiners.length);
  $("selectAll").checked = pageMiners.length > 0 && pageMiners.every((miner) => state.selected.has(miner.ip));
  if (pageMiners.length) {
    renderMinerRows(tbody, pageMiners, activeStatusIp);
  } else {
    hideStatePopover();
    tbody.dataset.pageIps = "";
    tbody.innerHTML = emptyMinerRow();
  }
  if (state.activeStatePopover?.wrapper.isConnected) {
    positionStatePopover(state.activeStatePopover.wrapper, state.activeStatePopover.popover);
  } else if (state.activeStatePopover) {
    hideStatePopover();
  }
  if (forcePager || !isEditingTablePager()) renderTablePager(state.minerTotal, pageCount);
}

function renderMinerRows(tbody, pageMiners, activeStatusIp) {
  const pageIps = pageMiners.map((miner) => miner.ip).join("\u001f");
  if (tbody.dataset.pageIps !== pageIps) {
    if (!activeStatusIp || !pageMiners.some((miner) => miner.ip === activeStatusIp)) hideStatePopover();
    tbody.dataset.pageIps = pageIps;
    tbody.innerHTML = pageMiners.map((miner) => minerRowHtml(miner)).join("");
    Array.from(tbody.querySelectorAll("tr[data-open-history]")).forEach((row) => {
      row.dataset.renderHash = minerRowHtml(pageMiners.find((miner) => miner.ip === row.dataset.openHistory));
    });
    return;
  }

  Array.from(tbody.querySelectorAll("tr[data-open-history]")).forEach((row, index) => {
    const miner = pageMiners[index];
    if (!miner) return;
    const html = minerRowHtml(miner);
    row.classList.toggle("selected-row", state.selected.has(miner.ip));
    if (miner.ip === activeStatusIp) return;
    if (row.dataset.renderHash !== html) {
      row.innerHTML = minerRowCellsHtml(miner);
      row.dataset.renderHash = html;
    }
  });
}

function minerRowHtml(miner) {
  return `
    <tr class="miner-row ${state.selected.has(miner.ip) ? "selected-row" : ""}" data-open-history="${escapeHtml(miner.ip)}">
      ${minerRowCellsHtml(miner)}
    </tr>
  `;
}

function minerRowCellsHtml(miner) {
  return `
    <td class="col-select"><input class="miner-select" data-ip="${miner.ip}" type="checkbox" ${state.selected.has(miner.ip) ? "checked" : ""} /></td>
    <td class="col-ip"><strong>${escapeHtml(miner.ip)}</strong></td>
    <td class="col-state">${statusBadge(miner)}</td>
    <td class="col-make">${escapeHtml(getMake(miner))}</td>
    <td class="col-model">${escapeHtml(getModel(miner))}</td>
    <td class="col-firmware">${escapeHtml(getFirmware(miner))}</td>
    <td>${escapeHtml(getHashratePair(miner) || "-")}</td>
    <td>${escapeHtml(number(miner.data?.wattage) || "-")}</td>
    <td>${escapeHtml(number(miner.data?.average_temperature) || "-")}</td>
    <td>${escapeHtml(getEfficiency(miner) || "-")}</td>
    <td>${escapeHtml(getFans(miner))}</td>
    <td class="col-pool">${escapeHtml(getPool(miner))}</td>
    <td class="col-pool-user">${escapeHtml(getPoolUser(miner))}</td>
  `;
}

function emptyMinerRow() {
  const hasRanges = state.ranges.length > 0;
  const hasEnabledRanges = normalizeEnabledRanges(state.enabledRanges, state.ranges).some(Boolean);
  const title = hasEnabledRanges ? "No miners found in enabled IP ranges" : "Add IP ranges to discover miners";
  const detail = hasRanges && !hasEnabledRanges
    ? "Enable at least one IP range, then run a scan."
    : "Add a range, then scan to populate this table.";
  return `
    <tr class="empty-row">
      <td colspan="13">
        <div class="table-empty">
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(detail)}</span>
          <button class="btn btn-primary" type="button" data-open-ranges>Add IP ranges</button>
        </div>
      </td>
    </tr>
  `;
}

function sortedMiners() {
  return [...state.miners];
}

function currentPageMiners(miners = sortedMiners()) {
  return miners;
}

function tableSummary(total, visible) {
  const selected = `${state.selected.size} selected`;
  if (!total) return selected;
  const start = (state.table.page - 1) * state.table.pageSize + 1;
  const end = start + visible - 1;
  return `${selected} · ${start}-${end} of ${total}`;
}

function renderTablePager(total, pageCount) {
  const pager = $("minerPager");
  if (!pager) return;
  const page = state.table.page;
  const html = `
    <div class="pager-count">${total ? `Page ${page} of ${pageCount}` : "No miners"}</div>
    <label class="pager-size">
      Rows
      <select id="minerPageSize">
        ${[10, 25, 50, 100].map((size) => `<option value="${size}" ${state.table.pageSize === size ? "selected" : ""}>${size}</option>`).join("")}
      </select>
    </label>
    <div class="pager-buttons">
      <button class="icon-btn" data-page-step="first" aria-label="First page" title="First page" ${page <= 1 ? "disabled" : ""}>|&lt;</button>
      <button class="icon-btn" data-page-step="previous" aria-label="Previous page" title="Previous page" ${page <= 1 ? "disabled" : ""}>&lt;</button>
      <button class="icon-btn" data-page-step="next" aria-label="Next page" title="Next page" ${page >= pageCount ? "disabled" : ""}>&gt;</button>
      <button class="icon-btn" data-page-step="last" aria-label="Last page" title="Last page" ${page >= pageCount ? "disabled" : ""}>&gt;|</button>
    </div>
  `;
  if (pager.dataset.renderHash === html) return;
  pager.dataset.renderHash = html;
  pager.innerHTML = html;
}

async function refreshIpReports() {
  if (state.ipReportRefreshing) return;
  state.ipReportRefreshing = true;
  try {
    applyIpReports(await api("/api/ip-reports"));
  } finally {
    state.ipReportRefreshing = false;
  }
}

function applyIpReports(data) {
  state.ipReports = {
    running: !!data.running,
    error: data.error || null,
    miners: data.miners || [],
  };
  renderIpReports();
}

function renderIpReports() {
  if (!$("ipReportRows")) return;
  const reports = state.ipReports.miners || [];
  const running = !!state.ipReports.running;
  const error = state.ipReports.error;
  $("ipReportToggle").textContent = running ? "Stop listening" : "Start listening";
  $("ipReportToggle").classList.toggle("active", running);
  $("ipReportCount").textContent = `${reports.length} report${reports.length === 1 ? "" : "s"}`;
  $("ipReportError").hidden = !error;
  $("ipReportError").textContent = error || "";
  $("ipReportRows").innerHTML = reports.length ? reports.map((miner) => `
    <tr>
      <td><strong>${escapeHtml(miner.ip)}</strong></td>
      <td>${escapeHtml(miner.make || "-")}</td>
      <td>${escapeHtml(miner.model || "-")}</td>
      <td>${escapeHtml(miner.firmware || "-")}</td>
    </tr>
  `).join("") : `
    <tr class="empty-row">
      <td colspan="4">
        <div class="table-empty">
          <strong>No IP reports heard</strong>
          <span>Start listening, then wait for miners to announce themselves.</span>
        </div>
      </td>
    </tr>
  `;
}

function tablePageCount(total = state.minerTotal) {
  return Math.max(1, Math.ceil(total / state.table.pageSize));
}

function clampTablePage(total = state.minerTotal) {
  state.table.page = Math.min(Math.max(1, state.table.page), tablePageCount(total));
}

function updateSortHeaders() {
  document.querySelectorAll("th[data-sort]").forEach((header) => {
    const active = header.dataset.sort === state.sort.key;
    header.classList.toggle("sorted", active);
    header.classList.toggle("sorted-asc", active && state.sort.direction === "asc");
    header.classList.toggle("sorted-desc", active && state.sort.direction === "desc");
    header.setAttribute("aria-sort", active ? (state.sort.direction === "asc" ? "ascending" : "descending") : "none");
    header.title = active
      ? `Sorted ${state.sort.direction === "asc" ? "ascending" : "descending"}`
      : "Click to sort";
  });
}

function sortMiner(a, b) {
  const key = state.sort.key;
  const values = {
    ip: [a.ip, b.ip],
    make: [getMake(a), getMake(b)],
    model: [getModel(a), getModel(b)],
    hostname: [getHostname(a), getHostname(b)],
    firmware: [getFirmware(a), getFirmware(b)],
    hashrate: [rateValue(a.data?.hashrate), rateValue(b.data?.hashrate)],
    expected_hashrate: [rateValue(a.data?.expected_hashrate), rateValue(b.data?.expected_hashrate)],
    wattage: [a.data?.wattage || 0, b.data?.wattage || 0],
    temperature: [a.data?.average_temperature || 0, b.data?.average_temperature || 0],
    efficiency: [numeric(a.data?.efficiency?.value || a.data?.efficiency), numeric(b.data?.efficiency?.value || b.data?.efficiency)],
    uptime: [numericDuration(a.data?.uptime), numericDuration(b.data?.uptime)],
    chips: [numeric(a.data?.working_chips ?? sum(a.data?.hashboards, "working_chips")), numeric(b.data?.working_chips ?? sum(b.data?.hashboards, "working_chips"))],
    boards: [numeric(a.data?.hashboards?.length), numeric(b.data?.hashboards?.length)],
    tuning: [numeric(a.data?.tuning_percent), numeric(b.data?.tuning_percent)],
    fans: [getFans(a), getFans(b)],
    pool: [getPool(a), getPool(b)],
    pool_user: [getPoolUser(a), getPoolUser(b)],
    state: [minerState(a).order, minerState(b).order],
  }[key] || [a.ip, b.ip];
  const result = values[0] > values[1] ? 1 : values[0] < values[1] ? -1 : 0;
  return state.sort.direction === "asc" ? result : -result;
}

function statusBadge(miner) {
  const detail = stateDetails(miner);
  const popover = statusPopover(detail);
  const state = minerState(miner);
  return `<span class="status-wrap" tabindex="0"><span class="status ${state.className}">${escapeHtml(state.label)}</span>${popover}</span>`;
}

function stateDetails(miner) {
  if (miner.loading) return ["Data collection is still running for this miner."];
  if (miner.error) return [miner.error];
  const messages = miner.data?.messages || [];
  const details = messages
    .filter((message) => message.severity === "Error" || message.severity === "Warning")
    .map(messageDetailText)
    .filter(Boolean);
  return details.length ? details : ["No reported errors or warnings."];
}

function statusPopover(details) {
  return `
    <span class="state-popover" role="tooltip">
      ${details.map((detail) => `<span>${escapeHtml(detail)}</span>`).join("")}
    </span>
  `;
}

function showStatePopover(wrapper) {
  const popover = wrapper.querySelector(".state-popover");
  if (!popover) return;
  hideStatePopover();
  state.activeStatePopover = { wrapper, popover };
  popover.classList.add("is-visible");
  positionStatePopover(wrapper, popover);
}

function hideStatePopover() {
  if (!state.activeStatePopover) return;
  state.activeStatePopover.popover.classList.remove("is-visible", "above");
  state.activeStatePopover = null;
}

function positionStatePopover(wrapper, popover) {
  const gap = 8;
  const margin = 12;
  const trigger = wrapper.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const left = Math.min(
    Math.max(trigger.left, margin),
    window.innerWidth - popoverRect.width - margin,
  );
  const below = trigger.bottom + gap;
  const above = trigger.top - popoverRect.height - gap;
  const hasBelowRoom = below + popoverRect.height <= window.innerHeight - margin;
  popover.classList.toggle("above", !hasBelowRoom && above >= margin);
  popover.style.left = `${left}px`;
  popover.style.top = `${hasBelowRoom || above < margin ? below : above}px`;
}

async function openHistory(ip) {
  const data = await api(`/api/history?ip=${encodeURIComponent(ip)}`);
  state.history = { ip, miner: data.miner, points: data.points || [] };
  showPage("history");
  renderHistory();
}

function renderHistory({ updateCharts = true } = {}) {
  const { ip, miner, points } = state.history;
  const latest = points.at(-1) || {};
  $("historyTitle").textContent = ip || "Miner History";
  $("historySubtitle").textContent = miner ? `${getMake(miner)} ${getModel(miner)} · ${getFirmware(miner)}` : "No miner selected.";
  $("openMinerWeb").disabled = !ip;
  $("historySummary").innerHTML = [
    importantMetricCard("State", miner ? minerState(miner).label : "-", miner?.last_seen ? `Seen ${new Date(miner.last_seen * 1000).toLocaleTimeString()}` : "No recent data"),
    importantMetricCard("Hashrate", miner ? getHashratePair(miner) || "-" : "-", "Reported / expected"),
    importantMetricCard("Power", hasValue(latest.wattage) ? `${number(latest.wattage)} W` : "-", "Latest sample"),
    importantMetricCard("Temperature", hasValue(latest.temperature) ? `${number(latest.temperature)} °C` : "-", "Latest sample"),
    importantMetricCard("Efficiency", hasValue(latest.efficiency) ? `${number(latest.efficiency)} J/TH` : "-", "Latest sample"),
    importantMetricCard("Uptime", miner ? getUptime(miner) : "-", "Current session"),
    importantMetricCard("Pool", miner ? getPool(miner) : "-", "Active pool"),
    importantMetricCard("Tuning", miner ? getTuning(miner) : "-", "Current target"),
  ].join("");
  renderMinerPageActions(miner);
  renderMinerDetailGroups(miner);
  renderMinerPools(miner);
  renderMinerFans(miner);
  renderMinerBoards(miner);
  renderMinerMessages(miner);
  if (updateCharts) {
    const expectedHashrate = miner ? getExpectedHashrateValue(miner) : null;
    const targetWattage = miner ? getTuningTargetWattage(miner) : null;
    renderHistoryChart("hashrateChart", points, [
      { key: "hashrate_value", label: latest.hashrate_unit || "Hashrate", color: "accent" },
      { key: "temperature", label: "°C", color: "critical" },
    ], expectedHashrate ? [{
      seriesKey: "hashrate_value",
      value: expectedHashrate,
      label: `Expected ${number(expectedHashrate)} ${latest.hashrate_unit || miner?.data?.expected_hashrate?.unit || ""}`.trim(),
      color: "warning",
    }] : [], { showLegend: false });
    renderHistoryChart("thermalChart", points, [
      { key: "wattage", label: "Watts", color: "info" },
    ], targetWattage ? [{
      seriesKey: "wattage",
      value: targetWattage,
      label: `Target ${number(targetWattage)} W`,
      color: "warning",
    }] : []);
  }
}

function importantMetricCard(label, value, detail) {
  return `
    <div class="important-summary-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `;
}

function renderMinerPageActions(miner) {
  const target = miner ? [miner] : [];
  const groups = actionGroups
    .map((group) => ({
      ...group,
      entries: availableActionsForGroup(group, target),
    }))
    .filter((group) => group.entries.length > 0);
  $("minerActionBar").hidden = state.page !== "history" || groups.length === 0;
  $("historyActionGroups").innerHTML = groups.map((group) => `
      <button class="btn ${group.entries.some((entry) => entry.unsupported.length) ? "partial-action" : ""}" data-history-action-group="${group.id}" type="button">
        ${escapeHtml(group.label)}
        <span>${actionGroupSummary(group, target)}</span>
      </button>
    `).join("");
}

function renderMinerDetailGroups(miner) {
  renderDetailGroup("minerDeviceDetails", miner, [
    ["Make", "data.device_info.make"],
    ["Model", "data.device_info.model"],
    ["Serial Number", "data.serial_number"],
    ["Control Board", "data.control_board_version"],
  ]);
  renderDetailGroup("minerNetworkDetails", miner, [
    ["IP", minerIp(miner)],
    ["Hostname", "data.hostname"],
    ["MAC", "data.mac"],
    ["Last Seen", miner?.last_seen],
  ]);
  renderDetailGroup("minerMiningDetails", miner, [
    ["Mining", "data.is_mining"],
    ["Hashrate", "data.hashrate"],
    ["Expected Hashrate", "data.expected_hashrate"],
    ["Tuning Percent", "data.tuning_percent"],
    ["Tuning Target", miner ? getTuning(miner) : "-"],
    ["Fault Light", "data.light_flashing"],
  ]);
  renderDetailGroup("minerThermalDetails", miner, [
    ["Wattage", "data.wattage"],
    ["Efficiency", "data.efficiency"],
    ["Average Temperature", "data.average_temperature"],
    ["Fluid Temperature", "data.fluid_temperature"],
    ["Outlet Fluid Temperature", "data.outlet_fluid_temperature"],
  ]);
  renderDetailGroup("minerFirmwareDetails", miner, [
    ["Firmware", miner ? getFirmware(miner) : "-"],
    ["Firmware Version", "data.firmware_version"],
    ["API Version", "data.api_version"],
    ["Schema Version", "data.schema_version"],
  ]);
}

function renderDetailGroup(id, miner, fields) {
  $(id).innerHTML = fields
    .map(([label, source]) => detailItem(label, typeof source === "string" && source.includes(".") ? valueByPath(miner, source) : source))
    .join("");
}

function renderMinerPools(miner) {
  const pools = poolCandidates(miner || {});
  $("minerPools").innerHTML = pools.length ? pools.map((pool, index) => {
    const status = pool.status || pool.state || pool.pool_status || (isActivePool(pool) ? "active" : "");
    const details = [
      ["User", poolValue(pool, ["user", "username", "pool_user", "poolUser", "worker", "worker_name", "workerName"])],
      ["Priority", poolValue(pool, ["priority", "prio"])],
      ["Quota", poolValue(pool, ["quota"])],
      ["Accepted", poolValue(pool, ["accepted", "accepted_shares", "acceptedShares"])],
      ["Rejected", poolValue(pool, ["rejected", "rejected_shares", "rejectedShares"])],
      ["Difficulty", poolValue(pool, ["difficulty", "diff"])],
      ["Last Share", poolValue(pool, ["last_share_time", "lastShareTime", "last_share", "lastShare"])],
    ].filter(([, value]) => hasValue(value));
    return poolCard(poolValue(pool, ["url", "pool_url", "poolUrl", "stratum_url", "stratumUrl", "uri"]) || `Pool ${index + 1}`, details, pool, status);
  }).join("") : `<div class="empty-list">No pools reported.</div>`;
}

function renderMinerFans(miner) {
  const fans = miner?.data?.fans || miner?.data?.fan_data || [];
  const psuFans = miner?.data?.psu_fans || [];
  const cards = [];
  if (Array.isArray(fans)) {
    cards.push(...fans.map((fan, index) => fanCard(fan, `Fan ${index + 1}`)));
  }
  if (Array.isArray(psuFans)) {
    cards.push(...psuFans.map((fan, index) => fanCard(fan, `PSU Fan ${index + 1}`)));
  }
  $("minerFans").innerHTML = cards.join("") || `<div class="empty-list">No fan details reported.</div>`;
}

function renderMinerBoards(miner) {
  const hashboards = miner?.data?.hashboards || [];
  $("minerBoards").innerHTML = Array.isArray(hashboards) && hashboards.length
    ? hashboards.map((board, index) => boardCard(board, index, miner, hashboards.length)).join("")
    : `<div class="empty-list">No hashboard details reported.</div>`;
}

function fanCard(fan, label) {
  const speed = firstFinite(fan, ["speed", "rpm", "value", "percent", "percentage"]);
  const isPercent = speed !== null && speed <= 100 && !hasAny(fan, ["rpm"]);
  const display = speed === null ? "-" : `${number(speed)}${isPercent ? "%" : " RPM"}`;
  const percent = isPercent ? speed : null;
  const state = fanLightState(fan, speed);
  return `
    <div class="hardware-card fan-card ${state.className}">
      <span class="hardware-light ${state.className}" title="${escapeHtml(state.label)}"></span>
      <div class="hardware-card-body">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(display)}</span>
        ${percent !== null ? progressBar(percent, `${number(percent)}% speed`) : ""}
        <small>${escapeHtml(state.label)}</small>
      </div>
    </div>
  `;
}

function boardCard(board, index, miner, boardCount) {
  const state = boardLightState(board);
  const working = firstFinite(board, ["working_chips", "chips_working", "active_chips", "good_chips"]);
  const expected = firstFinite(board, ["expected_chips", "nominal_chips", "total_chips", "chip_count", "chips"]);
  const chipPercent = expected && working !== null ? (working / expected) * 100 : null;
  const temp = firstFinite(board, ["temperature", "temp", "chip_temp", "average_temperature"]);
  const hashrate = board?.hashrate || board?.rate;
  const expectedHashrate = boardHashrateTarget(board, miner, boardCount, hashrate);
  const hashrateValue = rateValue(hashrate);
  const expectedHashrateValue = rateValue(expectedHashrate);
  const hashratePercent = hasValue(hashrate) && hasValue(expectedHashrate)
    ? expectedHashrateValue > 0 ? (hashrateValue / expectedHashrateValue) * 100 : 100
    : null;
  const active = activeField(board);
  return `
    <div class="hardware-card board-card ${state.className}">
      <span class="hardware-light ${state.className}" title="${escapeHtml(state.label)}"></span>
      <div class="hardware-card-body">
        <div class="hardware-card-title">
          <strong>${escapeHtml(board?.name || board?.id || `Board ${index + 1}`)}</strong>
        </div>
        <div class="board-meta">
          <span>${active ? "Active" : "Inactive"}</span>
          ${temp !== null ? `<span>${escapeHtml(number(temp))} °C</span>` : ""}
        </div>
        ${chipPercent !== null ? progressBar(chipPercent, `${number(working)} / ${number(expected)} chips`) : `<small>Chip count unavailable</small>`}
        ${hashratePercent !== null ? progressBar(hashratePercent, `${formatValue(hashrate)} / ${formatValue(expectedHashrate)}`) : `<small>Hashrate unavailable</small>`}
      </div>
    </div>
  `;
}

function boardHashrateTarget(board, miner, boardCount, currentHashrate) {
  const boardExpected = board?.expected_hashrate || board?.nominal_hashrate;
  if (hasValue(boardExpected)) return boardExpected;

  const minerExpected = miner?.data?.expected_hashrate;
  if (hasValue(minerExpected) && boardCount > 0) return divideRate(minerExpected, boardCount);

  return currentHashrate;
}

function divideRate(rate, divisor) {
  const value = rateValue(rate);
  const safeDivisor = Number(divisor) || 1;
  if (typeof rate === "object" && rate !== null) return { ...rate, value: value / safeDivisor };
  return value / safeDivisor;
}

function fanLightState(fan, speed) {
  const base = hardwareState(fan);
  if (base.className === "err" || base.className === "warn") return base;
  if (speed !== null) {
    if (speed > 0) return { label: "Running", className: "ok" };
    return { label: "Stopped", className: "inactive" };
  }
  if (activeField(fan)) return { label: "Running", className: "ok" };
  return { label: base.label, className: base.className || "inactive" };
}

function boardLightState(board) {
  const base = hardwareState(board);
  if (base.className === "err") return base;
  const active = activeField(board);
  if (!active) return { label: "Inactive", className: "inactive" };

  const working = firstFinite(board, ["working_chips", "chips_working", "active_chips", "good_chips"]);
  const expected = firstFinite(board, ["expected_chips", "nominal_chips", "total_chips", "chip_count", "chips"]);
  if (working === 0) return { label: "No chips", className: "err" };
  if (expected && working !== null && working < expected) return { label: "Chip count low", className: "warn" };

  const hashrate = rateValue(board?.hashrate || board?.rate);
  const expectedHashrate = rateValue(board?.expected_hashrate || board?.nominal_hashrate);
  if (expectedHashrate > 0 && hashrate < expectedHashrate * 0.8) return { label: "Low hashrate", className: "warn" };
  if (hashrate === 0 && expectedHashrate > 0) return { label: "No hashrate", className: "err" };
  if (base.className === "warn") return base;
  return { label: "Working", className: "ok" };
}

function progressBar(percent, label) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  return `
    <div class="mini-progress" aria-label="${escapeHtml(label)}">
      <span style="width: ${clamped}%"></span>
      <small>${escapeHtml(label)}</small>
    </div>
  `;
}

function hardwareState(item) {
  if (!item || typeof item !== "object") return { label: "Unknown", className: "" };
  const text = String(item.status || item.state || item.health || "").toLowerCase();
  if (item.error || item.fault || ["error", "fault", "failed", "dead", "missing"].some((value) => text.includes(value))) {
    return { label: titleize(item.status || item.state || "Issue"), className: "err" };
  }
  if (["warn", "warning", "degraded", "throttled"].some((value) => text.includes(value))) {
    return { label: titleize(item.status || item.state || "Warning"), className: "warn" };
  }
  if (activeField(item)) return { label: titleize(item.status || item.state || "Active"), className: "ok" };
  if (text) return { label: titleize(text), className: "paused" };
  return { label: "Reported", className: "" };
}

function activeField(item) {
  if (!item || typeof item !== "object") return false;
  if (item.active === false || item.enabled === false || item.is_active === false || item.online === false) return false;
  if (item.active === true || item.enabled === true || item.is_active === true || item.online === true) return true;
  const text = String(item.status || item.state || "").toLowerCase();
  return ["active", "online", "working", "ok", "alive", "tuned"].some((value) => text.includes(value));
}

function firstFinite(item, keys) {
  for (const key of keys) {
    const value = finiteValue(item?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function hasAny(item, keys) {
  return keys.some((key) => item?.[key] !== undefined && item?.[key] !== null && item?.[key] !== "");
}

function renderMinerMessages(miner) {
  const messages = miner?.data?.messages || [];
  $("minerMessages").innerHTML = messages.length ? messages.map((message) => {
    const severity = message.severity || message.level || message.kind || "Message";
    const text = message.message || message.text || message.detail || String(message);
    return messageCard(severity, text, messageCode(message));
  }).join("") : `<div class="empty-list">No messages reported.</div>`;
}

function detailItem(label, value) {
  return `
    <div class="detail-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(formatDetailValue(label, value))}</strong>
    </div>
  `;
}

function poolCard(title, details, pool, status) {
  const state = poolLightState(pool, status);
  return `
    <div class="detail-list-item pool-card ${state.className}">
      <span class="hardware-light ${state.className}" title="${escapeHtml(state.label)}"></span>
      <strong>${escapeHtml(title)}</strong>
      <div class="pool-details">
        ${details.length ? details.map(([label, value]) => `
          <span><b>${escapeHtml(label)}</b>${escapeHtml(formatDetailValue(label, value))}</span>
        `).join("") : `<span>No extra pool details</span>`}
      </div>
    </div>
  `;
}

function poolLightState(pool, status) {
  const text = String(status || pool?.status || pool?.state || pool?.pool_status || "").toLowerCase();
  if (isActivePool(pool) || ["active", "alive", "enabled", "online", "working"].some((value) => text.includes(value))) {
    return { label: "Active", className: "ok" };
  }
  return { label: "Inactive", className: "inactive" };
}

function messageCard(severity, text, code = null) {
  const state = messageStateClass(severity, text);
  return `
    <div class="detail-list-item message-card ${state}">
      <div class="message-card-head">
        <strong>${escapeHtml(severity || "Message")}</strong>
        ${code ? `<span class="message-code">Code ${escapeHtml(code)}</span>` : ""}
      </div>
      <span>${escapeHtml(text || "-")}</span>
    </div>
  `;
}

function messageDetailText(message) {
  const text = message.message || message.text || message.detail || String(message);
  const code = messageCode(message);
  return code ? `Code ${code}: ${text}` : text;
}

function messageCode(message) {
  if (!message || typeof message !== "object") return null;
  for (const key of ["code", "error_code", "errorCode", "message_code", "messageCode", "fault_code", "faultCode", "errno"]) {
    const value = message[key];
    if (isNonZeroCode(value)) return String(value).trim();
  }
  return null;
}

function isNonZeroCode(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim();
  if (!text) return false;
  const normalized = text.toLowerCase();
  if (["0", "0x0", "none", "null"].includes(normalized)) return false;
  const numeric = Number(text);
  return !Number.isFinite(numeric) || numeric !== 0;
}

function messageStateClass(severity, text) {
  const value = `${severity || ""} ${text || ""}`.toLowerCase();
  if (["error", "err", "fault", "fail", "critical", "fatal"].some((term) => value.includes(term))) return "err";
  if (["warn", "warning", "degraded", "throttle", "low"].some((term) => value.includes(term))) return "warn";
  if (["ok", "success", "healthy", "normal", "active"].some((term) => value.includes(term))) return "ok";
  return "info";
}

function listItem(title, detail) {
  return `
    <div class="detail-list-item">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail || "-")}</span>
    </div>
  `;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function renderHistoryChart(id, points, series, thresholds = [], settings = {}) {
  if (!window.ApexCharts) return;
  const options = historyChartOptions(points, series, thresholds, settings);
  state.chartDebug[id] = chartDebugInfo(id, points, options);
  const signature = chartSignature(options);
  if (state.charts[id] && state.chartHovering[id]) {
    state.chartPending[id] = { options, signature };
    return;
  }
  applyHistoryChartOptions(id, options, signature);
}

function applyHistoryChartOptions(id, options, signature = chartSignature(options)) {
  const existing = state.charts[id];
  if (existing) {
    if (existing.signature === signature) {
      existing.instance.updateSeries(options.series, false).catch((error) => {
        reportClientError({
          kind: "chart-series-update",
          message: errorMessage(error),
          stack: error?.stack,
          chart: state.chartDebug[id],
        });
        recreateHistoryChart(id, options, signature);
      });
    } else {
      existing.instance.updateOptions(options, false, false).then(() => {
        existing.signature = signature;
      }).catch((error) => {
        reportClientError({
          kind: "chart-options-update",
          message: errorMessage(error),
          stack: error?.stack,
          chart: state.chartDebug[id],
        });
        recreateHistoryChart(id, options, signature);
      });
    }
    return;
  }
  recreateHistoryChart(id, options, signature);
}

function applyPendingChartUpdate(id) {
  const pending = state.chartPending[id];
  if (!pending) return;
  delete state.chartPending[id];
  applyHistoryChartOptions(id, pending.options, pending.signature);
}

function recreateHistoryChart(id, options, signature = chartSignature(options)) {
  if (state.charts[id]) {
    state.charts[id].instance.destroy();
    delete state.charts[id];
  }
  const instance = new ApexCharts($(id), options);
  state.charts[id] = { instance, signature };
  instance.render().catch((error) => {
    reportClientError({
      kind: "chart-render",
      message: errorMessage(error),
      stack: error?.stack,
      chart: state.chartDebug[id],
    });
    toast(errorMessage(error));
  });
}

function chartSignature(options) {
  return JSON.stringify({
    annotations: options.annotations?.yaxis?.map((item) => [item.yAxisIndex, item.y, item.label?.text]),
    colors: options.colors,
    legend: options.legend.show,
    labels: options.series.map((item) => item.name),
    mode: options.theme.mode,
  });
}

function historyChartOptions(points, series, thresholds = [], settings = {}) {
  const text = cssColor("--text-secondary", "#666666");
  const muted = cssColor("--text-muted", "#888888");
  const border = cssColor("--border-10", "#e0e0e0");
  const surface = cssColor("--surface-base", "#ffffff");
  const colors = {
    accent: cssColor("--core-accent", "#fe7c00"),
    info: cssColor("--intent-info", "#0096d1"),
    critical: cssColor("--intent-critical", "#fa2b37"),
    warning: cssColor("--intent-warning", "#cf8500"),
  };
  const plottedSeries = series.map((item) => ({
    ...item,
    data: historyChartData(points, item.key),
  })).filter((item) => item.data.length > 1);
  const chartSeries = plottedSeries.map((item) => ({
    name: item.label,
    data: item.data,
  }));
  const yaxisAnnotations = thresholds.map((threshold) => {
    const value = finiteValue(threshold.value);
    const yAxisIndex = plottedSeries.findIndex((item) => item.key === threshold.seriesKey);
    if (value === null || yAxisIndex < 0) return null;
    const color = colors[threshold.color] || muted;
    return {
      y: value,
      yAxisIndex,
      borderColor: color,
      borderWidth: 1.5,
      strokeDashArray: 4,
      label: {
        borderColor: color,
        text: threshold.label,
        position: "right",
        offsetX: -6,
        style: {
          background: surface,
          color,
          fontSize: "11px",
          fontWeight: 600,
        },
      },
    };
  }).filter(Boolean);
  return {
    annotations: {
      yaxis: yaxisAnnotations,
    },
    chart: {
      type: "line",
      height: 260,
      parentHeightOffset: 0,
      toolbar: { show: false },
      zoom: { enabled: false },
      animations: { enabled: false },
      background: surface,
      foreColor: text,
      sparkline: { enabled: false },
    },
    colors: plottedSeries.map((item) => colors[item.color] || text),
    dataLabels: { enabled: false },
    fill: { opacity: 1 },
    grid: {
      borderColor: border,
      strokeDashArray: 4,
      padding: { top: 2, right: 12, bottom: 0, left: 8 },
    },
    legend: {
      show: settings.showLegend ?? plottedSeries.length > 1,
      position: "top",
      horizontalAlign: "left",
      labels: { colors: text },
      markers: { radius: 12 },
    },
    markers: { size: 0, hover: { size: 5 } },
    noData: {
      text: "No history samples yet",
      align: "left",
      verticalAlign: "middle",
      offsetX: 20,
      style: { color: muted, fontSize: "13px" },
    },
    series: chartSeries,
    stroke: { curve: "smooth", width: 2.5, lineCap: "round" },
    theme: { mode: resolvedThemeMode() },
    tooltip: {
      theme: resolvedThemeMode(),
      x: { format: "HH:mm:ss" },
      y: { formatter: (value) => hasValue(value) ? number(value) : "-" },
    },
    xaxis: {
      type: "datetime",
      axisBorder: { show: false },
      axisTicks: { show: false },
      labels: { style: { colors: muted } },
      tooltip: { enabled: false },
    },
    yaxis: plottedSeries.map((item, index) => ({
      decimalsInFloat: 1,
      min: 0,
      opposite: index > 0,
      labels: {
        style: { colors: muted },
        formatter: (value) => number(value),
      },
      title: {
        text: item.label,
        style: { color: muted, fontSize: "11px", fontWeight: 500 },
      },
    })),
  };
}

function historyChartData(points, key) {
  return points
    .map((point) => {
      const x = Number(point.timestamp) * 1000;
      const y = Number(point[key]);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    })
    .filter(Boolean);
}

function cssColor(variableName, fallback) {
  const probe = document.createElement("span");
  probe.style.color = `var(${variableName})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return normalizeCssColor(resolved, fallback);
}

function normalizeCssColor(value, fallback) {
  const context = normalizeCssColor.context || (normalizeCssColor.context = document.createElement("canvas").getContext("2d"));
  context.fillStyle = fallback;
  context.fillStyle = value;
  return context.fillStyle || fallback;
}

function chartDebugInfo(id, points, options) {
  return {
    id,
    theme: resolvedThemeMode(),
    pointCount: points.length,
    series: options.series.map((item) => ({
      name: item.name,
      length: item.data.length,
      first: item.data.at(0),
      last: item.data.at(-1),
    })),
    rawFirst: points.at(0),
    rawLast: points.at(-1),
  };
}

function resolvedThemeMode() {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function selectedMiners() {
  return state.miners.filter((miner) => state.selected.has(miner.ip));
}

function actionTargetMiners() {
  return state.pendingActionMiners || selectedMiners();
}

function supportedFor(action, miners = actionTargetMiners()) {
  return miners.filter((miner) => miner.supports?.[action.flag]);
}

function unsupportedFor(action, miners = actionTargetMiners()) {
  return miners.filter((miner) => !miner.supports?.[action.flag]);
}

function actionById(actionId) {
  return actionDefs.find((action) => action.id === actionId);
}

function actionGroupById(groupId) {
  return actionGroups.find((group) => group.id === groupId);
}

function actionAvailability(action, miners = selectedMiners()) {
  return {
    action,
    supported: supportedFor(action, miners),
    unsupported: unsupportedFor(action, miners),
  };
}

function availableActionsForGroup(group, miners = selectedMiners()) {
  return group.actions
    .map(actionById)
    .filter(Boolean)
    .map((action) => actionAvailability(action, miners))
    .filter((entry) => entry.supported.length > 0);
}

function availableActionGroups() {
  const miners = selectedMiners();
  if (!miners.length) return [];
  return actionGroups
    .map((group) => ({
      ...group,
      entries: availableActionsForGroup(group, miners),
    }))
    .filter((group) => group.entries.length > 0);
}

function actionGroupCoverage(group, miners) {
  const supportedIps = new Set();
  group.entries.forEach((entry) => {
    entry.supported.forEach((miner) => supportedIps.add(miner.ip));
  });
  return `${supportedIps.size}/${miners.length}`;
}

function actionGroupSummary(group, miners) {
  if (group.entries.length === 1) return `${group.entries[0].supported.length}/${miners.length}`;
  if (group.id === "mining_state" || group.id === "tuning") return actionGroupCoverage(group, miners);
  return `${group.entries.length} options`;
}

function renderSelectionBar() {
  const selected = selectedMiners();
  const bar = $("selectionBar");
  bar.hidden = state.page !== "miners" || selected.length === 0;
  $("selectionBarCount").textContent = `${selected.length} selected`;
  $("selectionBarHint").textContent = selected.length
    ? "Actions shown support at least one selected miner."
    : "Choose an action to apply.";
  $("selectionActions").innerHTML = availableActionGroups().map((group) => `
    <button class="btn ${group.entries.some((entry) => entry.unsupported.length) ? "partial-action" : ""}" data-open-action-group="${group.id}">
      ${escapeHtml(group.label)}
      <span>${actionGroupSummary(group, selected)}</span>
    </button>
  `).join("");
}

function openActionDialog(actionId, groupId = null, miners = state.pendingActionMiners || selectedMiners()) {
  const action = actionById(actionId);
  const group = groupId ? actionGroupById(groupId) : actionGroups.find((item) => item.actions.includes(actionId));
  if (!action || !group) return;
  renderActionDialog(group, action, miners);
  if (!$("actionDialog").open) $("actionDialog").showModal();
}

function openActionGroupDialog(groupId, miners = selectedMiners()) {
  const group = actionGroupById(groupId);
  if (!group) return;
  const entries = availableActionsForGroup(group, miners);
  if (!entries.length) return;
  renderActionDialog(group, defaultActionForGroup(group, entries, miners), miners);
  $("actionDialog").showModal();
}

function defaultActionForGroup(group, entries, miners = selectedMiners()) {
  if (group.id !== "mining_state") return entries[0].action;
  const wantsMiningOn = miners.length > 0 && miners.some((miner) => hasCurrentMinerData(miner) && miner.data?.is_mining);
  const actionId = wantsMiningOn ? "resume" : "pause";
  return entries.find((entry) => entry.action.id === actionId)?.action || entries[0].action;
}

function renderActionDialog(group, action, miners = selectedMiners()) {
  const supported = supportedFor(action, miners);
  const unsupported = unsupportedFor(action, miners);
  state.pendingAction = action;
  state.pendingActionMiners = miners;
  setActionSubmitting(false);

  $("actionTitle").textContent = group.label;
  $("actionSubtitle").textContent = `${supported.length} supported, ${unsupported.length} unsupported`;
  $("actionOptions").innerHTML = actionOptionsHtml(group, action, miners);
  $("actionSupportedList").innerHTML = renderDeviceList(supported, "No selected miner supports this action.");
  $("actionUnsupportedList").innerHTML = renderDeviceList(unsupported, "All selected miners support this action.");
  $("actionFields").innerHTML = actionFieldsHtml(action);
  $("applyAction").disabled = supported.length === 0;
}

function setActionSubmitting(submitting, message = "") {
  state.actionSubmitting = submitting;
  const status = $("actionStatus");
  status.hidden = !message;
  status.textContent = message;
  $("applyAction").disabled = submitting || supportedFor(state.pendingAction || {}).length === 0;
  $("applyAction").textContent = submitting ? "Sending..." : "Apply";
  $("cancelAction").disabled = submitting;
  $("closeAction").disabled = submitting;
  document.querySelectorAll("#actionDialog button[data-select-action], #actionDialog input, #actionDialog select").forEach((element) => {
    element.disabled = submitting;
  });
}

function actionOptionsHtml(group, activeAction, miners = actionTargetMiners()) {
  const entries = availableActionsForGroup(group, miners);
  if (group.id === "mining_state") return miningStateToggleHtml(activeAction, entries, miners);
  if (entries.length <= 1) return "";
  return `
    <div class="action-options" role="tablist" aria-label="${escapeHtml(group.label)} options">
      ${entries.map(({ action, supported, unsupported }) => `
        <button
          class="btn ${action.id === activeAction.id ? "active" : ""} ${unsupported.length ? "partial-action" : ""}"
          data-select-action="${action.id}"
          data-action-group="${group.id}"
          role="tab"
          aria-selected="${action.id === activeAction.id ? "true" : "false"}"
          type="button"
        >
          ${escapeHtml(action.label)}
          <span>${supported.length}/${miners.length}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function miningStateToggleHtml(activeAction, entries, miners = actionTargetMiners()) {
  const selectedCount = miners.length;
  const checked = activeAction.id === "resume";
  const availability = entries.find((entry) => entry.action.id === activeAction.id);
  return `
    <label class="action-toggle">
      <span>
        <strong>Mining</strong>
        <small>${checked ? "On" : "Off"} · ${escapeHtml(activeAction.label)} · ${availability ? `${availability.supported.length}/${selectedCount}` : `0/${selectedCount}`}</small>
      </span>
      <span class="switch">
        <input data-mining-state-toggle type="checkbox" ${checked ? "checked" : ""} />
        <i></i>
      </span>
    </label>
  `;
}

function renderDeviceList(miners, emptyText) {
  if (!miners.length) return `<div class="empty-list">${emptyText}</div>`;
  return miners.map((miner) => `
    <div class="device-list-item">
      <strong>${escapeHtml(miner.ip)}</strong>
      <span>${escapeHtml(getModel(miner))}</span>
    </div>
  `).join("");
}

function actionFieldsHtml(action) {
  if (action.custom === "pools") {
    return `
      <label>Group name<input name="name" value="default" /></label>
      <label>Quota<input name="quota" type="number" value="1" /></label>
      <label>Pool 1 URL<input name="pool_url_1" placeholder="stratum+tcp://pool.example:3333" /></label>
      <label>Pool 1 user<input name="pool_user_1" /></label>
      <label>Pool 1 password<input name="pool_pass_1" type="password" /></label>
      <label>Pool 2 URL<input name="pool_url_2" /></label>
      <label>Pool 2 user<input name="pool_user_2" /></label>
      <label>Pool 2 password<input name="pool_pass_2" type="password" /></label>
    `;
  }
  return action.fields.map((field) => fieldHtml(field)).join("");
}

function fieldHtml(field) {
  if (field.type === "select") {
    return `<label>${escapeHtml(field.label)}<select name="${field.name}">${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join("")}</select></label>`;
  }
  if (field.type === "checkbox") {
    return `<label class="checkbox-field"><input name="${field.name}" type="checkbox" />${escapeHtml(field.label)}</label>`;
  }
  return `<label>${escapeHtml(field.label)}<input name="${field.name}" type="${field.type}" ${field.min !== undefined ? `min="${field.min}"` : ""} ${field.max !== undefined ? `max="${field.max}"` : ""} /></label>`;
}

function collectPayload() {
  const action = state.pendingAction;
  const values = {};
  document.querySelectorAll("#actionFields input, #actionFields select").forEach((input) => {
    values[input.name] = input.type === "checkbox" ? input.checked : input.value;
  });
  if (action?.id === "pools") {
    values.groups = [{
      name: values.name,
      quota: values.quota,
      pools: [1, 2].map((idx) => ({
        url: values[`pool_url_${idx}`],
        username: values[`pool_user_${idx}`],
        password: values[`pool_pass_${idx}`],
      })).filter((pool) => pool.url),
    }];
  }
  values.username = $("authUser").value;
  values.password = $("authPass").value;
  return values;
}

function clearSelection() {
  state.selected.clear();
  renderTable();
  renderSelectionBar();
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest("button");
  const sortableHeader = target.closest("th[data-sort]");
  if (button?.matches(".nav")) showPage(button.dataset.page);
  if (button?.matches("[data-open-ranges]")) showPage("ranges");
  if (button?.id === "backToMiners") showPage("miners");
  if (button?.id === "openMinerWeb" && state.history.ip) window.open(`http://${state.history.ip}`, "_blank", "noopener,noreferrer");
  if (button?.id === "liveScanToggle") {
    const enabled = !state.schedule.liveScanning;
    await post("/api/live", { scanning: enabled });
    toast(enabled ? "Live scanning enabled" : "Live scanning disabled");
  }
  if (button?.id === "liveDataToggle") {
    const enabled = !state.schedule.liveDataUpdates;
    await post("/api/live", { data_updates: enabled });
    toast(enabled ? "Live data updates enabled" : "Live data updates disabled");
  }
  if (button?.id === "scanNow") {
    await post("/api/scan", {});
    toast("Scan started");
  }
  if (button?.id === "ipReportToggle") {
    try {
      const running = !state.ipReports.running;
      applyIpReports(await post("/api/ip-reports", { running }));
      toast(running ? "IP report listener started" : "IP report listener stopped");
    } catch (error) {
      toast(error.message);
    }
  }
  if (button?.id === "saveSettings") {
    try {
      await saveSettings();
    } catch (error) {
      toast(error.message);
    }
  }
  if (button?.id === "addRange") {
    const input = $("rangeInput");
    const nameInput = $("rangeNameInput");
    const range = input.value.trim();
    const name = nameInput.value.trim();
    if (!range) return;
    const previous = snapshotRanges();
    state.ranges.push(range);
    state.rangeNames.push(name);
    state.enabledRanges.push(true);
    state.rangeHosts.push(0);
    renderRanges();
    try {
      await persistRanges("Range added");
      input.value = "";
      nameInput.value = "";
      $("rangePreview").textContent = "";
    } catch (error) {
      restoreRanges(previous);
      renderRanges();
      toast(error.message);
    }
  }
  if (button?.dataset.removeRange !== undefined) {
    const previous = snapshotRanges();
    state.ranges.splice(Number(button.dataset.removeRange), 1);
    state.rangeNames.splice(Number(button.dataset.removeRange), 1);
    state.enabledRanges.splice(Number(button.dataset.removeRange), 1);
    state.rangeHosts.splice(Number(button.dataset.removeRange), 1);
    renderRanges();
    try {
      await persistRanges("Range removed");
    } catch (error) {
      restoreRanges(previous);
      renderRanges();
      toast(error.message);
    }
  }
  if (button?.dataset.moveRange !== undefined) {
    await moveRange(Number(button.dataset.moveRange), Number(button.dataset.moveDirection));
  }
  if (sortableHeader) {
    const key = sortableHeader.dataset.sort;
    state.sort.direction = state.sort.key === key && state.sort.direction === "asc" ? "desc" : "asc";
    state.sort.key = key;
    state.table.page = 1;
    await reloadMinerPage();
  }
  if (button?.dataset.pageStep) {
    const pageCount = tablePageCount();
    if (button.dataset.pageStep === "first") state.table.page = 1;
    if (button.dataset.pageStep === "previous") state.table.page -= 1;
    if (button.dataset.pageStep === "next") state.table.page += 1;
    if (button.dataset.pageStep === "last") state.table.page = pageCount;
    clampTablePage();
    await reloadMinerPage();
  }
  if (button?.dataset.openAction) openActionDialog(button.dataset.openAction);
  if (button?.dataset.openActionGroup) openActionGroupDialog(button.dataset.openActionGroup);
  if (button?.dataset.historyActionGroup && state.history.miner) openActionGroupDialog(button.dataset.historyActionGroup, [state.history.miner]);
  if (button?.dataset.selectAction && !state.actionSubmitting) openActionDialog(button.dataset.selectAction, button.dataset.actionGroup);
  const historyRow = target.closest("tr[data-open-history]");
  if (historyRow && !target.closest("input, button, a, label")) await openHistory(historyRow.dataset.openHistory);
  if (button?.id === "clearSelection") clearSelection();
  if (button?.id === "applyAction") {
    if (state.actionSubmitting) return;
    const action = state.pendingAction;
    if (!action) return;
    const supported = supportedFor(action);
    if (!supported.length) return;
    setActionSubmitting(true, `Command sent to ${supported.length} device${supported.length === 1 ? "" : "s"}. Waiting for response...`);
    try {
      const results = await post("/api/config", {
        ips: supported.map((miner) => miner.ip),
        action: action.id,
        payload: collectPayload(),
      });
      const failures = results.results.filter((result) => !result.ok);
      state.actionSubmitting = false;
      $("actionDialog").close();
      state.pendingActionMiners = null;
      toast(failures.length ? `${failures.length} action failed` : `${action.label} applied`);
    } catch (error) {
      setActionSubmitting(false, `Command failed: ${error.message}`);
      toast(error.message);
    }
  }
});

$("actionDialog").addEventListener("close", () => {
  if (state.actionSubmitting) return;
  state.pendingAction = null;
  state.pendingActionMiners = null;
  setActionSubmitting(false);
});

$("actionDialog").addEventListener("cancel", (event) => {
  if (state.actionSubmitting) event.preventDefault();
});

document.addEventListener("pointerover", (event) => {
  const wrapper = event.target instanceof HTMLElement ? event.target.closest(".status-wrap") : null;
  if (wrapper) showStatePopover(wrapper);
});

document.addEventListener("pointerout", (event) => {
  const wrapper = event.target instanceof HTMLElement ? event.target.closest(".status-wrap") : null;
  const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
  if (wrapper && !wrapper.contains(related)) hideStatePopover();
});

document.addEventListener("focusin", (event) => {
  const wrapper = event.target instanceof HTMLElement ? event.target.closest(".status-wrap") : null;
  if (wrapper) showStatePopover(wrapper);
});

document.addEventListener("focusout", (event) => {
  const wrapper = event.target instanceof HTMLElement ? event.target.closest(".status-wrap") : null;
  const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
  if (wrapper && !wrapper.contains(related)) hideStatePopover();
});

window.addEventListener("scroll", () => {
  if (state.activeStatePopover) positionStatePopover(state.activeStatePopover.wrapper, state.activeStatePopover.popover);
}, true);

window.addEventListener("resize", () => {
  if (state.activeStatePopover) positionStatePopover(state.activeStatePopover.wrapper, state.activeStatePopover.popover);
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.matches("#settings input, #settings select")) state.settingsDirty = true;
  if (target.matches("[data-range-enabled]")) {
    const index = Number(target.dataset.rangeEnabled);
    const previous = [...state.enabledRanges];
    state.enabledRanges = normalizeEnabledRanges(state.enabledRanges, state.ranges);
    state.enabledRanges[index] = target.checked;
    renderRanges();
    try {
      await persistRanges(target.checked ? "Range enabled" : "Range disabled");
    } catch (error) {
      state.enabledRanges = previous;
      renderRanges();
      toast(error.message);
    }
  }
  if (target.matches("[data-range-edit]")) {
    await editRange(Number(target.dataset.rangeEdit), target.value);
  }
  if (target.matches("[data-range-name-edit]")) {
    await editRangeName(Number(target.dataset.rangeNameEdit), target.value);
  }
  if (target.id === "appearanceSelect") applyAppearance(target.value);
  if (target.matches("[data-mining-state-toggle]")) {
    openActionDialog(target.checked ? "resume" : "pause", "mining_state");
  }
  if (target.id === "selectAll") {
    currentPageMiners().forEach((miner) => target.checked ? state.selected.add(miner.ip) : state.selected.delete(miner.ip));
    renderTable();
    renderSelectionBar();
  }
  if (target.matches(".miner-select")) {
    target.checked ? state.selected.add(target.dataset.ip) : state.selected.delete(target.dataset.ip);
    renderTable();
    renderSelectionBar();
  }
  if (target.id === "minerPageSize") {
    const previousPageSize = state.table.pageSize;
    const firstVisibleIndex = (state.table.page - 1) * previousPageSize;
    state.table.pageSize = Number(target.value) || 10;
    state.table.page = Math.floor(firstVisibleIndex / state.table.pageSize) + 1;
    clampTablePage();
    await reloadMinerPage();
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.matches("#settings input, #settings select")) state.settingsDirty = true;
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches("[data-range-edit], [data-range-name-edit]")) return;
  if (event.key === "Enter") {
    event.preventDefault();
    target.blur();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    target.value = target.matches("[data-range-name-edit]")
      ? state.rangeNames[Number(target.dataset.rangeNameEdit)] || ""
      : state.ranges[Number(target.dataset.rangeEdit)] || "";
    target.blur();
  }
});

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((document.documentElement.dataset.theme || "system") === "system") {
    updateFavicon("system");
    updateChartThemes();
  }
});

["hashrateChart", "thermalChart"].forEach((id) => {
  $(id).addEventListener("pointerenter", () => {
    state.chartHovering[id] = true;
  });
  $(id).addEventListener("pointerleave", () => {
    state.chartHovering[id] = false;
    applyPendingChartUpdate(id);
  });
});

$("rangeInput").addEventListener("input", async (event) => {
  const value = event.target.value.trim();
  const request = ++state.rangePreviewRequest;
  if (!value) {
    $("rangePreview").textContent = "";
    return;
  }
  try {
    const data = await api(`/api/range-preview?range=${encodeURIComponent(value)}`);
    if (request !== state.rangePreviewRequest) return;
    $("rangePreview").textContent = `${data.estimated_hosts} hosts · ${data.preview.join(", ")}${data.estimated_hosts > data.preview.length ? ", ..." : ""}`;
  } catch (error) {
    if (request !== state.rangePreviewRequest) return;
    $("rangePreview").textContent = error.message;
  }
});

$("rangeSearchInput").addEventListener("input", (event) => {
  state.rangeSearch = event.target.value;
  renderRanges();
});

setInterval(renderSchedule, 1000);
setInterval(() => {
  if (state.page === "ipReports" || state.ipReports.running) {
    refreshIpReports().catch((error) => toast(error.message));
  }
}, 2000);
connectStatusStream();
connectLiveReload();

function connectLiveReload() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/api/live-reload`);
  socket.addEventListener("message", (event) => {
    if (event.data === "reload") window.location.reload();
  });
  socket.addEventListener("close", () => setTimeout(connectLiveReload, 1000));
}

function connectStatusStream() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const path = statusStreamPath();
  if (
    state.statusSocket
    && state.statusSocketPath === path
    && [WebSocket.CONNECTING, WebSocket.OPEN].includes(state.statusSocket.readyState)
  ) return;
  if (state.statusSocket) {
    const previous = state.statusSocket;
    state.statusSocket = null;
    previous.close();
  }
  state.statusSocketPath = path;
  const socket = new WebSocket(`${protocol}://${window.location.host}${path}`);
  state.statusSocket = socket;
  socket.addEventListener("message", (event) => {
    if (state.statusSocket !== socket || state.statusSocketPath !== path) return;
    try {
      applyStatus(JSON.parse(event.data));
    } catch (error) {
      toast(error.message);
    }
  });
  socket.addEventListener("close", () => {
    if (state.statusSocket !== socket) return;
    state.statusSocket = null;
    refresh().catch((error) => toast(error.message));
    setTimeout(connectStatusStream, 1000);
  });
  socket.addEventListener("error", () => socket.close());
}
