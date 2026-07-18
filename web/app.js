// xdash 前端逻辑：登录、设备列表、设备详情、实时轮询、历史趋势图

const TOKEN_KEY = "xdash_token";
const POLL_DEVICES = 3000; // 设备列表/详情轮询间隔
const POLL_HISTORY = 15000; // 历史图表刷新间隔
const REQUEST_TIMEOUT = 8000;

const $ = (sel) => document.querySelector(sel);
const token = () => localStorage.getItem(TOKEN_KEY);

let pollTimer = null;
let historyTimer = null;
let currentDeviceId = null;
let devicesLoading = false;
let detailLoadingDevice = null;
let historyLoadingKey = null;
// 历史图表实例（详情页切换时销毁重建）
const charts = {};

// ---------- 工具 ----------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetchWithTimeout(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // token 失效，回到登录
    logout();
    throw new Error("未授权");
  }
  return data;
}

async function fetchWithTimeout(path, options = {}, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(path, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
}

// 按百分比返回负载等级：>=80% crit(红)，>=50% warn(琥珀)，否则正常(绿)
function loadClass(pct) {
  if (pct >= 80) return "crit";
  if (pct >= 50) return "warn";
  return "";
}

// ASCII 进度条：用 █ ░ 拼 10 格，配合 CSS 变色
function asciiBar(pct, width = 10) {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtBytes(n) {
  if (n == null) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtRate(bytesPerSec) {
  return `${fmtBytes(bytesPerSec)}/s`;
}

function fmtUptime(sec) {
  if (!sec) return "-";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分钟`;
  return `${m}分钟`;
}

function fmtAgo(ts) {
  if (!ts) return "从未";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 5) return "刚刚";
  if (s < 60) return `${s}秒前`;
  return `${Math.floor(s / 60)}分钟前`;
}

// ---------- 登录 ----------
async function init() {
  if (token()) {
    showApp();
  } else {
    showLogin();
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = $("#login-password").value;
    const submitBtn = $("#login-form button");
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    $("#login-error").textContent = "";
    try {
      const res = await fetchWithTimeout("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        localStorage.setItem(TOKEN_KEY, data.token);
        showApp();
      } else {
        $("#login-error").textContent = data.error || "登录失败";
      }
    } catch {
      $("#login-error").textContent = "网络超时，请稍后重试";
    } finally {
      submitBtn.disabled = false;
    }
  });

  $("#logout-btn").addEventListener("click", logout);
  $("#back-btn").addEventListener("click", showDevices);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  $("#cleanup-offline-btn").addEventListener("click", cleanupOfflineDevices);
}

// 清理所有当前离线设备
async function cleanupOfflineDevices() {
  if (!confirm("确定清理所有当前离线的设备吗？\n这些设备的实时数据和历史记录将被永久清除。")) return;
  const btn = $("#cleanup-offline-btn");
  btn.disabled = true;
  const data = await api("/api/devices", { method: "DELETE" }).catch(() => null);
  btn.disabled = false;
  if (data && data.ok) {
    const n = data.count ?? 0;
    alert(n > 0 ? `已清理 ${n} 个离线设备` : "当前没有离线设备");
    loadDevices();
  } else {
    alert(data?.error || "清理失败");
  }
}

function showLogin() {
  $("#login-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
}

function showApp() {
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  showDevices();
}

// ---------- 设备列表 ----------
function showDevices() {
  currentDeviceId = null;
  $("#detail-view").classList.add("hidden");
  $("#devices-view").classList.remove("hidden");
  stopPolling();
  destroyCharts();
  loadDevices();
  startDevicesPolling();
}

async function loadDevices() {
  if (devicesLoading || currentDeviceId) return;
  devicesLoading = true;
  try {
    const data = await api("/api/devices").catch(() => null);
    if (!data || !data.ok || currentDeviceId) return;
    renderDevices(data.devices);
  } finally {
    devicesLoading = false;
  }
}

function renderDevices(devices) {
  const grid = $("#devices-grid");
  const toolbar = $("#devices-toolbar");
  const nodeCount = $("#node-count");
  const onlineCount = devices.filter((d) => d.online).length;
  const offlineCount = devices.length - onlineCount;
  // 工具栏始终显示（含节点统计），仅当有离线设备时才显示清理按钮
  toolbar.classList.toggle("hidden", devices.length === 0);
  if (devices.length) {
    nodeCount.textContent = `${devices.length} nodes · ${onlineCount} online${offlineCount ? ` · ${offlineCount} offline` : ""}`;
  }
  // 清理按钮的显隐独立控制
  $("#cleanup-offline-btn").style.display = offlineCount > 0 ? "" : "none";

  if (!devices.length) {
    grid.innerHTML = '<p class="empty">NO DEVICES // 等待客户端上报数据...</p>';
    return;
  }
  grid.innerHTML = devices
    .map((d) => {
      const status = d.online
        ? '<span class="badge online">ONLINE</span>'
        : '<span class="badge offline">OFFLINE</span>';
      const cpu = d.cpu_percent ?? 0;
      const mem = d.memory_percent ?? 0;
      const cpuCls = loadClass(cpu);
      const memCls = loadClass(mem);
      // 离线设备显示删除按钮
      const delBtn = d.online
        ? ""
        : `<button class="card-del-btn" data-id="${escapeHtml(d.device_id)}" data-name="${escapeHtml(d.hostname || d.device_id)}" title="删除该设备">DEL</button>`;
      return `
        <div class="device-card" data-id="${escapeHtml(d.device_id)}">
          <div class="card-head">
            <strong>${escapeHtml(d.hostname || d.device_id)}</strong>
            ${status}
          </div>
          <div class="card-os">${escapeHtml(d.os_name || "")} ${escapeHtml(d.os_version || "")}</div>
          <div class="card-ip">${escapeHtml(d.ip_public || "-")}</div>
          <div class="card-metrics">
            <div class="metric">
              <span class="label">CPU</span>
              <span class="value ${cpuCls}">${cpu.toFixed(1)}%</span>
              <span class="bar ${cpuCls}">${asciiBar(cpu)}</span>
            </div>
            <div class="metric">
              <span class="label">MEM</span>
              <span class="value ${memCls}">${mem.toFixed(1)}%</span>
              <span class="bar ${memCls}">${asciiBar(mem)}</span>
            </div>
          </div>
          <div class="card-foot">
            <span class="updated">${fmtAgo(d.last_seen)}</span>
            ${delBtn}
          </div>
        </div>`;
    })
    .join("");

  grid.querySelectorAll(".device-card").forEach((card) => {
    card.addEventListener("click", () => openDevice(card.dataset.id));
  });
  // 删除按钮：阻止冒泡到卡片点击，避免误进详情
  grid.querySelectorAll(".card-del-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!confirm(`确定删除设备「${name}」吗？\n该设备的实时数据和历史记录将被永久清除。`)) return;
      const data = await api(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
      if (data && data.ok) {
        loadDevices();
      } else {
        alert(data?.error || "删除失败");
      }
    });
  });
}

// ---------- 设备详情 ----------
function openDevice(deviceId) {
  currentDeviceId = deviceId;
  currentRange = "1h";
  $("#devices-view").classList.add("hidden");
  $("#detail-view").classList.remove("hidden");
  stopPolling();
  setupDetailShell();
  loadDetail();
  loadHistory(currentRange);
  startDetailPolling();
}

let currentRange = "1h";

function setupDetailShell() {
  $("#detail-content").innerHTML = `
    <div id="detail-live"></div>
    <div class="charts-block">
      <div class="charts-head">
        <h3>历史趋势</h3>
        <div class="range-btns">
          <button data-range="1h" class="active">1小时</button>
          <button data-range="6h">6小时</button>
          <button data-range="24h">24小时</button>
        </div>
      </div>
      <canvas id="chart-cpu" height="100"></canvas>
      <canvas id="chart-net" height="100"></canvas>
    </div>
  `;

  document.querySelectorAll(".range-btns button").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentRange = btn.dataset.range;
      document.querySelectorAll(".range-btns button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      loadHistory(currentRange);
    });
  });
}

async function loadDetail() {
  if (!currentDeviceId) return;
  const deviceId = currentDeviceId;
  if (detailLoadingDevice === deviceId) return;
  detailLoadingDevice = deviceId;
  try {
    const data = await api(`/api/devices/${encodeURIComponent(deviceId)}`).catch(() => null);
    if (!data || !data.ok || currentDeviceId !== deviceId) return;
    renderDetail(data.device);
  } finally {
    if (detailLoadingDevice === deviceId) {
      detailLoadingDevice = null;
    }
  }
}

function renderDetail(d) {
  const cpu = d.cpu_percent ?? 0;
  const mem = d.memory_percent ?? 0;
  const availableMemory = d.available_memory ?? calcAvailableMemory(d.total_memory, mem);
  const status = d.online
    ? '<span class="badge online">ONLINE</span>'
    : '<span class="badge offline">OFFLINE</span>';

  $("#detail-live").innerHTML = `
    <div class="detail-head">
      <h2>${escapeHtml(d.hostname || d.device_id)} ${status}</h2>
      <div class="info-grid">
        <div><span>操作系统</span><b>${escapeHtml(d.os_name || "-")} ${escapeHtml(d.os_version || "")}</b></div>
        <div><span>内核</span><b>${escapeHtml(d.kernel || "-")}</b></div>
        <div><span>架构</span><b>${escapeHtml(d.arch || "-")}</b></div>
        <div><span>运行时长</span><b>${fmtUptime(d.uptime_seconds)}</b></div>
        <div><span>本地 IP</span><b>${escapeHtml(d.ip_local || "-")}</b></div>
        <div><span>公网 IP</span><b>${escapeHtml(d.ip_public || "-")}</b></div>
        <div><span>CPU 型号</span><b>${escapeHtml(d.cpu_model || "-")} (${d.cpu_cores || 0} 核)</b></div>
        <div><span>总内存</span><b>${fmtBytes(d.total_memory)}</b><small>可用 ${fmtBytes(availableMemory)}</small></div>
      </div>
    </div>

    <div class="big-metrics">
      <div class="big-metric">
        <div class="ring ${loadClass(cpu)}" style="--p:${cpu.toFixed(0)}"><span>${cpu.toFixed(1)}%</span></div>
        <span>CPU</span>
      </div>
      <div class="big-metric">
        <div class="ring ${loadClass(mem)}" style="--p:${mem.toFixed(0)}"><span>${mem.toFixed(1)}%</span></div>
        <span>MEM</span>
      </div>
    </div>

    <div class="panels">
      ${topPanel("CPU 占用前 5", d.cpu_top, "cpu")}
      ${topPanel("内存占用前 5 <span class='metric-tag'>PSS</span>", d.memory_top, "mem")}
    </div>

    <div class="table-block">
      <h3>硬盘</h3>
      ${diskTable(d.disk)}
    </div>
    <div class="table-block">
      <h3>网络</h3>
      ${netTable(d.network)}
    </div>
    <p class="updated">最后更新：${fmtAgo(d.last_seen)}</p>
  `;
}

function calcAvailableMemory(total, percent) {
  if (total == null || percent == null) return null;
  const usedRatio = Math.min(100, Math.max(0, percent)) / 100;
  return Math.max(0, Math.round(total * (1 - usedRatio)));
}

function topPanel(title, items, field) {
  if (!items || !items.length) return "";
  // cpu: 百分比；mem: PSS 字节（共享内存按进程数均分，之和≈真实占用）
  const val = (it) =>
    field === "cpu" ? `${(it.cpu ?? 0).toFixed(1)}%` : fmtBytes(it.mem ?? 0);
  // mem 面板追加一行口径说明
  const note =
    field === "mem"
      ? '<p class="panel-note">PSS：共享内存按进程均分，比 RSS 更接近真实占用</p>'
      : "";
  return `
    <div class="top-panel">
      <h4>${title}</h4>
      <ol>${items.map((it) => `<li><span class="pname">${escapeHtml(it.name)}</span><span class="pval">${val(it)}</span></li>`).join("")}</ol>
      ${note}
    </div>`;
}

function diskTable(disk) {
  if (!disk || !disk.length) return '<p class="empty">无数据</p>';
  return `<table><thead><tr><th>挂载点</th><th>已用</th><th>总量</th><th>使用率</th></tr></thead><tbody>
    ${disk.map((d) => `<tr><td>${escapeHtml(d.mount)}</td><td>${fmtBytes(d.used)}</td><td>${fmtBytes(d.total)}</td><td>${(d.percent ?? 0).toFixed(1)}%</td></tr>`).join("")}
  </tbody></table>`;
}

function netTable(network) {
  if (!network || !network.length) return '<p class="empty">无数据</p>';
  return `<table><thead><tr><th>网卡</th><th>下行</th><th>上行</th></tr></thead><tbody>
    ${network.map((n) => `<tr><td>${escapeHtml(n.name)}</td><td>${fmtRate(n.rx_rate ?? 0)}</td><td>${fmtRate(n.tx_rate ?? 0)}</td></tr>`).join("")}
  </tbody></table>`;
}

// ---------- 历史图表 ----------
async function loadHistory(range) {
  if (!currentDeviceId) return;
  const deviceId = currentDeviceId;
  const requestKey = `${deviceId}:${range}`;
  if (historyLoadingKey === requestKey) return;
  currentRange = range;
  historyLoadingKey = requestKey;
  try {
    const data = await api(`/api/devices/${encodeURIComponent(deviceId)}/history?range=${range}`).catch(() => null);
    if (!data || !data.ok || currentDeviceId !== deviceId || currentRange !== range) return;
    drawCharts(data.points);
  } finally {
    if (historyLoadingKey === requestKey) {
      historyLoadingKey = null;
    }
  }
}

function drawCharts(points) {
  const labels = points.map((p) => new Date(p.ts * 1000).toLocaleTimeString());
  const cpuData = points.map((p) => p.cpu_percent);
  const memData = points.map((p) => p.memory_percent);
  const rxData = points.map((p) => p.net_rx);
  const txData = points.map((p) => p.net_tx);

  charts.cpu = updateLineChart(charts.cpu, $("#chart-cpu"), labels, [
    { label: "CPU %", data: cpuData, borderColor: "#00ff41", tension: 0.3, fill: false },
    { label: "内存 %", data: memData, borderColor: "#ffb000", tension: 0.3, fill: false },
  ]);

  charts.net = updateLineChart(charts.net, $("#chart-net"), labels, [
    { label: "下行 B/s", data: rxData, borderColor: "#00e5e5", tension: 0.3, fill: false },
    { label: "上行 B/s", data: txData, borderColor: "#ff3344", tension: 0.3, fill: false },
  ]);
}

function updateLineChart(chart, canvas, labels, datasets) {
  if (!canvas) return chart;
  if (!chart) {
    return new Chart(canvas, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        animation: false,
        plugins: { legend: { labels: { color: "#4a8a4a", font: { family: "monospace" } } } },
        scales: gridStyle(),
      },
    });
  }
  chart.data.labels = labels;
  chart.data.datasets = datasets;
  chart.update("none");
  return chart;
}

function gridStyle() {
  const ticks = { color: "#4a8a4a", font: { family: "monospace" } };
  const grid = { color: "rgba(0, 255, 65, 0.08)" };
  return { x: { ticks, grid }, y: { ticks, grid, beginAtZero: true } };
}

// ---------- 轮询控制 ----------
function startDevicesPolling() {
  if (document.hidden) return;
  pollTimer = setInterval(loadDevices, POLL_DEVICES);
}

function startDetailPolling() {
  if (document.hidden) return;
  pollTimer = setInterval(loadDetail, POLL_DEVICES);
  historyTimer = setInterval(() => loadHistory(currentRange), POLL_HISTORY);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (historyTimer) clearInterval(historyTimer);
  pollTimer = null;
  historyTimer = null;
}

function handleVisibilityChange() {
  if (!token()) return;
  if (document.hidden) {
    stopPolling();
    return;
  }
  if (currentDeviceId) {
    loadDetail();
    loadHistory(currentRange);
    startDetailPolling();
  } else if (!$("#app-view").classList.contains("hidden")) {
    loadDevices();
    startDevicesPolling();
  }
}

function destroyCharts() {
  Object.values(charts).forEach((c) => c && c.destroy());
  charts.cpu = null;
  charts.net = null;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

init();
