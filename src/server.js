import express from "express";
import { runBackfill, getActiveRun, cancelActiveRun } from "./backfill.js";
import { getDb, getBackfillRuns } from "./db.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// SSE clients waiting for log stream
const sseClients = new Set();

function broadcastLog(msg) {
  for (const res of sseClients) {
    try {
      res.write(`data: ${JSON.stringify({ type: "log", msg })}\n\n`);
    } catch (_) {}
  }
}

function broadcastStats(stats) {
  for (const res of sseClients) {
    try {
      res.write(`data: ${JSON.stringify({ type: "stats", stats })}\n\n`);
    } catch (_) {}
  }
}

// ── SSE stream endpoint ──────────────────────────────────────────────────────
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);

  // Send current run state immediately on connect
  const run = getActiveRun();
  if (run) {
    res.write(`data: ${JSON.stringify({ type: "status", run: sanitizeRun(run) })}\n\n`);
  }

  req.on("close", () => sseClients.delete(res));
});

// ── Start backfill ───────────────────────────────────────────────────────────
app.post("/start", async (req, res) => {
  const { startDate, endDate, resumeRunId } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate required (YYYY-MM-DD)" });

  const run = getActiveRun();
  if (run && !run.done) return res.status(409).json({ error: "A backfill is already running" });

  res.json({ started: true, message: `Backfill started: ${startDate} → ${endDate}` });

  // Run async — log via SSE
  runBackfill({
    startDate,
    endDate,
    resumeRunId: resumeRunId || null,
    onLog: (msg) => {
      broadcastLog(msg);
      const activeRun = getActiveRun();
      if (activeRun?.stats) broadcastStats(activeRun.stats);
    },
  }).catch(err => {
    broadcastLog(`[Backfill] 💥 ${err.message}`);
  });
});

// ── Cancel ───────────────────────────────────────────────────────────────────
app.post("/cancel", (req, res) => {
  cancelActiveRun();
  res.json({ cancelled: true });
});

// ── Status ───────────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const run = getActiveRun();
  res.json({ run: run ? sanitizeRun(run) : null });
});

// ── Run history ──────────────────────────────────────────────────────────────
app.get("/runs", async (req, res) => {
  try {
    const runs = await getBackfillRuns();
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sanitizeRun(run) {
  return {
    runId: run.runId,
    startDate: run.startDate,
    endDate: run.endDate,
    startedAt: run.startedAt,
    done: run.done,
    cancelled: run.cancelled,
    stats: run.stats,
  };
}

// ── Web UI ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ARCH Backfill Tool</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; }
  header { background: #1a1f2e; border-bottom: 1px solid #2d3748; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 18px; font-weight: 600; color: #63b3ed; }
  header span { font-size: 13px; color: #718096; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
  .card { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  .card h2 { font-size: 14px; font-weight: 600; color: #a0aec0; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px; }
  .form-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-group label { font-size: 12px; color: #718096; font-weight: 500; }
  .form-group input { background: #0f1117; border: 1px solid #2d3748; color: #e2e8f0; padding: 8px 12px; border-radius: 6px; font-size: 14px; outline: none; }
  .form-group input:focus { border-color: #63b3ed; }
  .btn { padding: 9px 20px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: #3182ce; color: #fff; }
  .btn-danger { background: #e53e3e; color: #fff; }
  .btn-secondary { background: #2d3748; color: #e2e8f0; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }
  .stat-box { background: #0f1117; border: 1px solid #2d3748; border-radius: 8px; padding: 14px; text-align: center; }
  .stat-box .val { font-size: 28px; font-weight: 700; color: #63b3ed; }
  .stat-box .lbl { font-size: 11px; color: #718096; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-box.green .val { color: #48bb78; }
  .stat-box.yellow .val { color: #ecc94b; }
  .stat-box.red .val { color: #fc8181; }
  .progress-bar { background: #2d3748; border-radius: 999px; height: 8px; overflow: hidden; margin-top: 12px; }
  .progress-fill { height: 100%; background: #3182ce; border-radius: 999px; transition: width 0.4s; }
  #log { background: #0a0d14; border: 1px solid #2d3748; border-radius: 8px; padding: 14px; font-family: "Courier New", monospace; font-size: 12px; line-height: 1.6; height: 380px; overflow-y: auto; color: #a0aec0; }
  #log .entry { white-space: pre-wrap; word-break: break-all; }
  #log .entry.ok { color: #48bb78; }
  #log .entry.warn { color: #ecc94b; }
  #log .entry.err { color: #fc8181; }
  #log .entry.info { color: #63b3ed; }
  .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; }
  .status-badge.running { background: #1a3a5c; color: #63b3ed; }
  .status-badge.idle { background: #1a2e1a; color: #48bb78; }
  .status-badge.error { background: #3a1a1a; color: #fc8181; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .dot.pulse { animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; color: #718096; font-weight: 500; border-bottom: 1px solid #2d3748; font-size: 11px; text-transform: uppercase; }
  td { padding: 8px 10px; border-bottom: 1px solid #1a1f2e; color: #e2e8f0; }
  tr:hover td { background: #1a1f2e; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .tag.complete { background: #1a3a1a; color: #48bb78; }
  .tag.running { background: #1a3a5c; color: #63b3ed; }
  .tag.cancelled { background: #2d3748; color: #a0aec0; }
  .tag.error { background: #3a1a1a; color: #fc8181; }
  .resume-btn { font-size: 11px; padding: 3px 8px; }
</style>
</head>
<body>
<header>
  <h1>ARCH Backfill Tool</h1>
  <span>MA Policy Recording Backfill — Standalone</span>
  <div style="margin-left:auto;" id="statusBadge">
    <span class="status-badge idle"><span class="dot"></span>Idle</span>
  </div>
</header>

<div class="container">

  <!-- Controls -->
  <div class="card">
    <h2>Start Backfill</h2>
    <div class="form-row">
      <div class="form-group">
        <label>Application Date Start</label>
        <input type="date" id="startDate">
      </div>
      <div class="form-group">
        <label>Application Date End</label>
        <input type="date" id="endDate">
      </div>
      <button class="btn btn-primary" id="startBtn" onclick="startBackfill()">▶ Start</button>
      <button class="btn btn-danger" id="cancelBtn" onclick="cancelBackfill()" disabled>⛔ Stop</button>
    </div>
    <div id="progressWrap" style="display:none; margin-top:16px;">
      <div style="font-size:12px; color:#718096; margin-bottom:6px;" id="progressLabel">Processing...</div>
      <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
    </div>
  </div>

  <!-- Stats -->
  <div class="card">
    <h2>Current Run Stats</h2>
    <div class="stats-grid">
      <div class="stat-box"><div class="val" id="sTotal">—</div><div class="lbl">Total</div></div>
      <div class="stat-box"><div class="val" id="sProcessed">—</div><div class="lbl">Processed</div></div>
      <div class="stat-box green"><div class="val" id="sAttached">—</div><div class="lbl">Attached</div></div>
      <div class="stat-box yellow"><div class="val" id="sSkipped">—</div><div class="lbl">Skipped</div></div>
      <div class="stat-box yellow"><div class="val" id="sNoRec">—</div><div class="lbl">No Recordings</div></div>
      <div class="stat-box yellow"><div class="val" id="sNoPhone">—</div><div class="lbl">No Phone</div></div>
      <div class="stat-box red"><div class="val" id="sErrors">—</div><div class="lbl">Errors</div></div>
    </div>
  </div>

  <!-- Log -->
  <div class="card">
    <h2 style="display:flex; justify-content:space-between; align-items:center;">
      Live Log
      <button class="btn btn-secondary" style="font-size:11px; padding:4px 10px;" onclick="clearLog()">Clear</button>
    </h2>
    <div id="log"></div>
  </div>

  <!-- Run History -->
  <div class="card">
    <h2>Run History</h2>
    <table id="historyTable">
      <thead><tr>
        <th>Date Range</th><th>Started</th><th>Status</th>
        <th>Total</th><th>Attached</th><th>Errors</th><th></th>
      </tr></thead>
      <tbody id="historyBody"><tr><td colspan="7" style="color:#718096; text-align:center; padding:20px;">Loading...</td></tr></tbody>
    </table>
  </div>

</div>

<script>
let evtSource = null;
let isRunning = false;

function connectSSE() {
  evtSource = new EventSource("/stream");
  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === "log") appendLog(data.msg);
    if (data.type === "stats") updateStats(data.stats);
    if (data.type === "status") {
      if (data.run && !data.run.done) setRunning(true);
    }
  };
  evtSource.onerror = () => setTimeout(connectSSE, 3000);
}

function appendLog(msg) {
  const log = document.getElementById("log");
  const div = document.createElement("div");
  div.className = "entry " + classForMsg(msg);
  div.textContent = msg;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function classForMsg(msg) {
  if (msg.includes("✅") || msg.includes("Complete")) return "ok";
  if (msg.includes("❌") || msg.includes("💥") || msg.includes("Fatal")) return "err";
  if (msg.includes("⚠") || msg.includes("⛔") || msg.includes("Cancelled")) return "warn";
  if (msg.includes("📊") || msg.includes("▶") || msg.includes("🔍")) return "info";
  return "";
}

function clearLog() {
  document.getElementById("log").innerHTML = "";
}

function updateStats(stats) {
  if (!stats) return;
  document.getElementById("sTotal").textContent = stats.total ?? "—";
  document.getElementById("sProcessed").textContent = stats.processed ?? "—";
  document.getElementById("sAttached").textContent = stats.attached ?? "—";
  document.getElementById("sSkipped").textContent = stats.skipped ?? "—";
  document.getElementById("sNoRec").textContent = stats.noRecordings ?? "—";
  document.getElementById("sNoPhone").textContent = stats.noPhone ?? "—";
  document.getElementById("sErrors").textContent = stats.errors ?? "—";

  if (stats.total > 0) {
    const pct = Math.round((stats.processed / stats.total) * 100);
    document.getElementById("progressFill").style.width = pct + "%";
    document.getElementById("progressLabel").textContent =
      stats.processed + " of " + stats.total + " processed (" + pct + "%)";
    document.getElementById("progressWrap").style.display = "block";
  }
}

function setRunning(running) {
  isRunning = running;
  document.getElementById("startBtn").disabled = running;
  document.getElementById("cancelBtn").disabled = !running;
  const badge = document.getElementById("statusBadge");
  badge.innerHTML = running
    ? '<span class="status-badge running"><span class="dot pulse"></span>Running</span>'
    : '<span class="status-badge idle"><span class="dot"></span>Idle</span>';
}

async function startBackfill() {
  const startDate = document.getElementById("startDate").value;
  const endDate = document.getElementById("endDate").value;
  if (!startDate || !endDate) { alert("Please select both dates."); return; }
  if (startDate > endDate) { alert("Start date must be before end date."); return; }

  clearLog();
  setRunning(true);
  appendLog("[UI] Starting backfill: " + startDate + " → " + endDate);

  const res = await fetch("/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startDate, endDate }),
  });
  const data = await res.json();
  if (!res.ok) {
    appendLog("[UI] Error: " + (data.error || "Unknown error"));
    setRunning(false);
    return;
  }

  // Poll for completion
  pollStatus();
}

async function cancelBackfill() {
  await fetch("/cancel", { method: "POST" });
  appendLog("[UI] Stop requested...");
}

async function pollStatus() {
  const check = async () => {
    const res = await fetch("/status");
    const data = await res.json();
    if (data.run) {
      updateStats(data.run.stats);
      if (data.run.done) {
        setRunning(false);
        loadHistory();
        return;
      }
    }
    if (isRunning) setTimeout(check, 3000);
  };
  setTimeout(check, 2000);
}

async function loadHistory() {
  const res = await fetch("/runs");
  const data = await res.json();
  const tbody = document.getElementById("historyBody");
  if (!data.runs || data.runs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:#718096; text-align:center; padding:20px;">No runs yet</td></tr>';
    return;
  }
  tbody.innerHTML = data.runs.map(r => {
    const started = r.startedAt ? new Date(r.startedAt).toLocaleString() : "—";
    const s = r.stats || {};
    return \`<tr>
      <td>\${r.startDate || "?"} → \${r.endDate || "?"}</td>
      <td>\${started}</td>
      <td><span class="tag \${r.status || ''}">\${r.status || "—"}</span></td>
      <td>\${s.total ?? "—"}</td>
      <td>\${s.attached ?? "—"}</td>
      <td>\${s.errors ?? "—"}</td>
      <td>\${r.status === "cancelled" || r.status === "error"
        ? \`<button class="btn btn-secondary resume-btn" onclick="resumeRun('\${r.runId}', '\${r.startDate}', '\${r.endDate}')">↩ Resume</button>\`
        : ""}</td>
    </tr>\`;
  }).join("");
}

async function resumeRun(runId, startDate, endDate) {
  if (!confirm("Resume this run? It will skip already-processed policies.")) return;
  document.getElementById("startDate").value = startDate;
  document.getElementById("endDate").value = endDate;
  clearLog();
  setRunning(true);
  appendLog("[UI] Resuming run " + runId);

  const res = await fetch("/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startDate, endDate, resumeRunId: runId }),
  });
  const data = await res.json();
  if (!res.ok) { appendLog("[UI] Error: " + (data.error || "Unknown")); setRunning(false); return; }
  pollStatus();
}

// Init
connectSSE();
loadHistory();

// Default date range — last 6 months to today
const today = new Date();
const sixMonthsAgo = new Date(today);
sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
document.getElementById("endDate").value = today.toISOString().split("T")[0];
document.getElementById("startDate").value = sixMonthsAgo.toISOString().split("T")[0];
</script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Backfill Tool] Server running on port ${PORT}`);
});
