const state = {
  ranges: [],
  miners: [],
  selected: new Set(),
  sort: { key: "ip", direction: "asc" },
  page: "miners",
  pendingAction: null,
  history: { ip: null, miner: null, points: [] },
  charts: {},
  activeStatePopover: null,
  settings: { scan_interval: 30, data_update_interval: 30, auto_clear_offline: false, appearance: "system" },
  settingsDirty: false,
  rangesPending: false,
  rangePreviewRequest: 0,
  nextScanAtMs: null,
  nextDataAtMs: null,
  schedule: { liveScanning: false, liveDataUpdates: false, hasRanges: false, scanRunning: false, dataUpdateRunning: false },
};

const pages = {
  ranges: ["IP Ranges", "Add octet ranges using a-b.c-d.e-f.g-h notation."],
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
  state.page = page;
  document.querySelectorAll(".page").forEach((el) => el.classList.toggle("active", el.id === page));
  document.querySelectorAll(".nav").forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $("pageTitle").textContent = pages[page].at(0);
  $("pageSubtitle").textContent = pages[page].at(1);
}

async function refresh() {
  const data = await api("/api/status");
  applyStatus(data);
}

function applyStatus(data) {
  if (!state.rangesPending) state.ranges = data.ranges || [];
  state.miners = data.miners || [];
  if (!state.settingsDirty) state.settings = data.settings || state.settings;
  applyAppearance(state.settings.appearance);
  state.selected = new Set([...state.selected].filter((ip) => state.miners.some((miner) => miner.ip === ip)));
  updateScheduleState(data);
  renderAll();
  if (data.last_scan_error) toast(data.last_scan_error);
}

function updateScheduleState(data) {
  const now = Date.now();
  state.nextScanAtMs = Number.isFinite(data.next_scan_in) ? now + data.next_scan_in * 1000 : null;
  state.nextDataAtMs = Number.isFinite(data.next_data_update_in) ? now + data.next_data_update_in * 1000 : null;
  state.schedule = {
    liveScanning: !!data.live_scanning,
    liveDataUpdates: !!data.live_data_updates,
    hasRanges: (data.ranges || []).length > 0,
    scanRunning: !!data.scan_running,
    dataUpdateRunning: !!data.data_update_running,
  };
  renderSchedule();
}

function renderAll() {
  if (!state.rangesPending) renderRanges();
  renderSettings();
  renderHomeStats();
  renderTable();
  if (state.page === "history" && state.history.ip) renderHistory();
  renderSelectionBar();
  renderSchedule();
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
  if (miner.error) return { label: "Offline", className: "offline", order: 0 };
  const hasData = miner.data && Object.keys(miner.data).length > 0;
  if (!hasData || !miner.last_seen) return { label: "Offline", className: "offline", order: 0 };
  const errors = minerErrors(miner);
  if (errors) return { label: `${errors} issue${errors === 1 ? "" : "s"}`, className: "err", order: 1 };
  const warnings = (miner.data?.messages || []).filter((message) => message.severity === "Warning").length;
  if (warnings) return { label: `${warnings} warning${warnings === 1 ? "" : "s"}`, className: "warn", order: 2 };
  if (miner.data?.is_mining === true) return { label: "Mining", className: "ok", order: 4 };
  if (miner.data?.is_mining === false) return { label: "Paused", className: "paused", order: 3 };
  return { label: "Unknown", className: "", order: 1 };
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

function getHashrate(miner) {
  const rate = miner.data?.hashrate;
  if (!rate) return "";
  return `${number(rate.value)} ${rate.unit || ""}`.trim();
}

function getEfficiency(miner) {
  const efficiency = miner.data?.efficiency;
  if (!efficiency) return "";
  if (typeof efficiency === "object") return `${number(efficiency.value)} ${efficiency.unit || ""}`.trim();
  return number(efficiency);
}

function getFans(miner) {
  const fans = miner.data?.fans || miner.data?.fan_data || [];
  if (!Array.isArray(fans) || !fans.length) return "-";
  const speeds = fans
    .map((fan) => fan?.speed || fan?.rpm || fan?.value)
    .filter((value) => value !== undefined && value !== null && value !== "");
  if (!speeds.length) return `${fans.length} fan${fans.length === 1 ? "" : "s"}`;
  return speeds.map(number).join(" / ");
}

function getPool(miner) {
  const pools = miner.data?.pools || miner.data?.pool_data || [];
  const active = Array.isArray(pools)
    ? pools.find((pool) => pool?.active || pool?.status === "active" || pool?.is_active) || pools[0]
    : null;
  return active?.url || active?.pool_url || active?.user || active?.username || "-";
}

function number(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function renderHomeStats() {
  const miners = state.miners;
  const totalWatts = miners.reduce((sum, miner) => sum + numeric(miner.data?.wattage), 0);
  const temps = miners.map((miner) => numeric(miner.data?.average_temperature)).filter((value) => value > 0);
  const hashrates = miners.map((miner) => numeric(miner.data?.hashrate?.value)).filter((value) => value > 0);
  const unit = miners.find((miner) => miner.data?.hashrate?.unit)?.data.hashrate.unit || "";
  const mining = miners.filter((miner) => miner.data?.is_mining).length;
  const issues = miners.filter((miner) => minerErrors(miner) > 0).length;
  $("homeStats").innerHTML = [
    metricCard("Miners", number(miners.length), `${mining} mining`),
    metricCard("Issues", number(issues), issues ? "Needs attention" : "No active issues"),
    metricCard("Hashrate", `${number(hashrates.reduce((sum, value) => sum + value, 0))} ${unit}`.trim() || "-", "Reported total"),
    metricCard("Power", totalWatts ? `${number(totalWatts)} W` : "-", "Reported draw"),
    metricCard("Average °C", temps.length ? number(temps.reduce((sum, value) => sum + value, 0) / temps.length) : "-", "Online miners"),
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
  $("rangeList").innerHTML = state.ranges.map((range, index) => `
    <span class="chip">${escapeHtml(range)}<button class="btn" data-remove-range="${index}">x</button></span>
  `).join("");
}

async function persistRanges(message = "Ranges updated") {
  state.rangesPending = true;
  try {
    const data = await post("/api/ranges", { ranges: state.ranges });
    state.ranges = data.ranges || [];
    renderRanges();
    toast(message);
  } finally {
    state.rangesPending = false;
  }
}

function renderSettings(force = false) {
  if (state.settingsDirty && !force) return;
  $("scanIntervalInput").value = state.settings.scan_interval ?? 30;
  $("dataUpdateIntervalInput").value = state.settings.data_update_interval ?? 30;
  $("autoClearOfflineToggle").checked = !!state.settings.auto_clear_offline;
  $("appearanceSelect").value = state.settings.appearance || "system";
  applyAppearance($("appearanceSelect").value);
}

async function saveSettings() {
  const scanInterval = Number($("scanIntervalInput").value);
  const dataUpdateInterval = Number($("dataUpdateIntervalInput").value);
  const payload = {
    scan_interval: scanInterval,
    data_update_interval: dataUpdateInterval,
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
  updateChartThemes();
}

function updateChartThemes() {
  if (!Object.keys(state.charts).length) return;
  if (state.page !== "history" || !state.history.ip) return;
  renderHistory();
}

function renderTable() {
  hideStatePopover();
  const miners = [...state.miners].sort(sortMiner);
  $("selectionCount").textContent = `${state.selected.size} selected`;
  $("selectAll").checked = miners.length > 0 && miners.every((miner) => state.selected.has(miner.ip));
  $("minerRows").innerHTML = miners.map((miner) => `
    <tr class="miner-row ${state.selected.has(miner.ip) ? "selected-row" : ""}" data-open-history="${escapeHtml(miner.ip)}">
      <td class="col-select"><input class="miner-select" data-ip="${miner.ip}" type="checkbox" ${state.selected.has(miner.ip) ? "checked" : ""} /></td>
      <td class="col-ip"><strong>${escapeHtml(miner.ip)}</strong></td>
      <td class="col-state">${statusBadge(miner)}</td>
      <td class="col-make">${escapeHtml(getMake(miner))}</td>
      <td class="col-model">${escapeHtml(getModel(miner))}</td>
      <td class="col-firmware">${escapeHtml(getFirmware(miner))}</td>
      <td>${escapeHtml(getHashrate(miner) || "-")}</td>
      <td>${escapeHtml(number(miner.data?.wattage) || "-")}</td>
      <td>${escapeHtml(number(miner.data?.average_temperature) || "-")}</td>
      <td>${escapeHtml(getEfficiency(miner) || "-")}</td>
      <td>${escapeHtml(getFans(miner))}</td>
      <td class="col-pool">${escapeHtml(getPool(miner))}</td>
    </tr>
  `).join("");
}

function sortMiner(a, b) {
  const key = state.sort.key;
  const values = {
    ip: [a.ip, b.ip],
    make: [getMake(a), getMake(b)],
    model: [getModel(a), getModel(b)],
    firmware: [getFirmware(a), getFirmware(b)],
    hashrate: [a.data?.hashrate?.value || 0, b.data?.hashrate?.value || 0],
    wattage: [a.data?.wattage || 0, b.data?.wattage || 0],
    temperature: [a.data?.average_temperature || 0, b.data?.average_temperature || 0],
    efficiency: [numeric(a.data?.efficiency?.value || a.data?.efficiency), numeric(b.data?.efficiency?.value || b.data?.efficiency)],
    fans: [getFans(a), getFans(b)],
    pool: [getPool(a), getPool(b)],
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
  if (miner.error) return [miner.error];
  const messages = miner.data?.messages || [];
  const details = messages
    .filter((message) => message.severity === "Error" || message.severity === "Warning")
    .map((message) => message.message || message.text || String(message))
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

function renderHistory() {
  const { ip, miner, points } = state.history;
  const latest = points.at(-1) || {};
  $("historyTitle").textContent = ip || "Miner History";
  $("historySubtitle").textContent = miner ? `${getMake(miner)} ${getModel(miner)} · ${getFirmware(miner)}` : "No miner selected.";
  $("openMinerWeb").disabled = !ip;
  $("historySummary").innerHTML = [
    metricCard("Samples", number(points.length), "Last 30 minutes"),
    metricCard("Hashrate", hasValue(latest.hashrate_value) ? `${number(latest.hashrate_value)} ${latest.hashrate_unit || ""}`.trim() : "-", "Latest sample"),
    metricCard("Power", hasValue(latest.wattage) ? `${number(latest.wattage)} W` : "-", "Latest sample"),
    metricCard("°C", hasValue(latest.temperature) ? number(latest.temperature) : "-", "Latest sample"),
    metricCard("Efficiency", hasValue(latest.efficiency) ? number(latest.efficiency) : "-", "Latest sample"),
  ].join("");
  renderHistoryChart("hashrateChart", points, [
    { key: "hashrate_value", label: latest.hashrate_unit || "Hashrate", color: "accent" },
  ]);
  renderHistoryChart("thermalChart", points, [
    { key: "wattage", label: "Watts", color: "info" },
    { key: "temperature", label: "°C", color: "critical" },
  ]);
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function renderHistoryChart(id, points, series) {
  if (!window.ApexCharts) return;
  const options = historyChartOptions(points, series);
  if (state.charts[id]) {
    state.charts[id].updateOptions(options, false, true);
    return;
  }
  state.charts[id] = new ApexCharts($(id), options);
  state.charts[id].render();
}

function historyChartOptions(points, series) {
  const styles = getComputedStyle(document.documentElement);
  const text = styles.getPropertyValue("--text-secondary").trim();
  const muted = styles.getPropertyValue("--text-muted").trim();
  const border = styles.getPropertyValue("--border-10").trim();
  const surface = styles.getPropertyValue("--surface-base").trim();
  const colors = {
    accent: styles.getPropertyValue("--core-accent").trim(),
    info: styles.getPropertyValue("--intent-info").trim(),
    critical: styles.getPropertyValue("--intent-critical").trim(),
  };
  const hasData = points.length > 1 && series.some((item) => points.some((point) => hasValue(point[item.key])));
  return {
    chart: {
      type: "area",
      height: 260,
      parentHeightOffset: 0,
      toolbar: { show: false },
      zoom: { enabled: false },
      animations: { enabled: false },
      background: surface,
      foreColor: text,
      sparkline: { enabled: false },
    },
    colors: series.map((item) => colors[item.color]),
    dataLabels: { enabled: false },
    fill: {
      type: "gradient",
      gradient: { opacityFrom: 0.22, opacityTo: 0.02, stops: [0, 90, 100] },
    },
    grid: {
      borderColor: border,
      strokeDashArray: 4,
      padding: { top: 2, right: 12, bottom: 0, left: 8 },
    },
    legend: {
      show: series.length > 1,
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
    series: hasData ? series.map((item) => ({
      name: item.label,
      data: points.map((point) => ({
        x: point.timestamp ? point.timestamp * 1000 : Date.now(),
        y: hasValue(point[item.key]) ? numeric(point[item.key]) : null,
      })),
    })) : [],
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
    yaxis: {
      decimalsInFloat: 1,
      labels: {
        style: { colors: muted },
        formatter: (value) => number(value),
      },
    },
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

function supportedFor(action, miners = selectedMiners()) {
  return miners.filter((miner) => miner.supports?.[action.flag]);
}

function unsupportedFor(action, miners = selectedMiners()) {
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

function renderSelectionBar() {
  const selected = selectedMiners();
  const bar = $("selectionBar");
  bar.hidden = selected.length === 0;
  $("selectionBarCount").textContent = `${selected.length} selected`;
  $("selectionBarHint").textContent = selected.length
    ? "Actions shown support at least one selected miner."
    : "Choose an action to apply.";
  $("selectionActions").innerHTML = availableActionGroups().map((group) => `
    <button class="btn ${group.entries.some((entry) => entry.unsupported.length) ? "partial-action" : ""}" data-open-action-group="${group.id}">
      ${escapeHtml(group.label)}
      <span>${group.entries.length === 1 ? `${group.entries[0].supported.length}/${selected.length}` : `${group.entries.length} options`}</span>
    </button>
  `).join("");
}

function openActionDialog(actionId, groupId = null) {
  const action = actionById(actionId);
  const group = groupId ? actionGroupById(groupId) : actionGroups.find((item) => item.actions.includes(actionId));
  if (!action || !group) return;
  renderActionDialog(group, action);
  if (!$("actionDialog").open) $("actionDialog").showModal();
}

function openActionGroupDialog(groupId) {
  const group = actionGroupById(groupId);
  if (!group) return;
  const entries = availableActionsForGroup(group);
  if (!entries.length) return;
  renderActionDialog(group, defaultActionForGroup(group, entries));
  $("actionDialog").showModal();
}

function defaultActionForGroup(group, entries) {
  if (group.id !== "mining_state") return entries[0].action;
  const selected = selectedMiners();
  const wantsMiningOn = selected.length > 0 && selected.some((miner) => miner.data?.is_mining);
  const actionId = wantsMiningOn ? "resume" : "pause";
  return entries.find((entry) => entry.action.id === actionId)?.action || entries[0].action;
}

function renderActionDialog(group, action) {
  const supported = supportedFor(action);
  const unsupported = unsupportedFor(action);
  state.pendingAction = action;

  $("actionTitle").textContent = group.label;
  $("actionSubtitle").textContent = `${supported.length} supported, ${unsupported.length} unsupported`;
  $("actionOptions").innerHTML = actionOptionsHtml(group, action);
  $("actionSupportedList").innerHTML = renderDeviceList(supported, "No selected miner supports this action.");
  $("actionUnsupportedList").innerHTML = renderDeviceList(unsupported, "All selected miners support this action.");
  $("actionFields").innerHTML = actionFieldsHtml(action);
  $("applyAction").disabled = supported.length === 0;
}

function actionOptionsHtml(group, activeAction) {
  const entries = availableActionsForGroup(group);
  if (group.id === "mining_state") return miningStateToggleHtml(activeAction, entries);
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
          <span>${supported.length}/${selectedMiners().length}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function miningStateToggleHtml(activeAction, entries) {
  const selectedCount = selectedMiners().length;
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
  if (button?.id === "saveSettings") {
    try {
      await saveSettings();
    } catch (error) {
      toast(error.message);
    }
  }
  if (button?.id === "addRange") {
    const input = $("rangeInput");
    const range = input.value.trim();
    if (!range) return;
    const previous = [...state.ranges];
    state.ranges.push(range);
    renderRanges();
    try {
      await persistRanges("Range added");
      input.value = "";
      $("rangePreview").textContent = "";
    } catch (error) {
      state.ranges = previous;
      renderRanges();
      toast(error.message);
    }
  }
  if (button?.dataset.removeRange !== undefined) {
    const previous = [...state.ranges];
    state.ranges.splice(Number(button.dataset.removeRange), 1);
    renderRanges();
    try {
      await persistRanges("Range removed");
    } catch (error) {
      state.ranges = previous;
      renderRanges();
      toast(error.message);
    }
  }
  if (sortableHeader) {
    const key = sortableHeader.dataset.sort;
    state.sort.direction = state.sort.key === key && state.sort.direction === "asc" ? "desc" : "asc";
    state.sort.key = key;
    renderTable();
  }
  if (button?.dataset.openAction) openActionDialog(button.dataset.openAction);
  if (button?.dataset.openActionGroup) openActionGroupDialog(button.dataset.openActionGroup);
  if (button?.dataset.selectAction) openActionDialog(button.dataset.selectAction, button.dataset.actionGroup);
  const historyRow = target.closest("tr[data-open-history]");
  if (historyRow && !target.closest("input, button, a, label")) await openHistory(historyRow.dataset.openHistory);
  if (button?.id === "clearSelection") clearSelection();
  if (button?.id === "applyAction") {
    const action = state.pendingAction;
    if (!action) return;
    const supported = supportedFor(action);
    const results = await post("/api/config", {
      ips: supported.map((miner) => miner.ip),
      action: action.id,
      payload: collectPayload(),
    });
    const failures = results.results.filter((result) => !result.ok);
    $("actionDialog").close();
    toast(failures.length ? `${failures.length} action failed` : `${action.label} applied`);
  }
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
  if (target.id === "appearanceSelect") applyAppearance(target.value);
  if (target.matches("[data-mining-state-toggle]")) {
    openActionDialog(target.checked ? "resume" : "pause", "mining_state");
  }
  if (target.id === "selectAll") {
    state.miners.forEach((miner) => target.checked ? state.selected.add(miner.ip) : state.selected.delete(miner.ip));
    renderTable();
    renderSelectionBar();
  }
  if (target.matches(".miner-select")) {
    target.checked ? state.selected.add(target.dataset.ip) : state.selected.delete(target.dataset.ip);
    renderTable();
    renderSelectionBar();
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.matches("#settings input, #settings select")) state.settingsDirty = true;
});

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((document.documentElement.dataset.theme || "system") === "system") updateChartThemes();
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

setInterval(renderSchedule, 1000);
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
  const socket = new WebSocket(`${protocol}://${window.location.host}/api/status-stream`);
  socket.addEventListener("message", (event) => {
    try {
      applyStatus(JSON.parse(event.data));
    } catch (error) {
      toast(error.message);
    }
  });
  socket.addEventListener("close", () => {
    refresh().catch((error) => toast(error.message));
    setTimeout(connectStatusStream, 1000);
  });
  socket.addEventListener("error", () => socket.close());
}
