'use strict';

/* Web Load & Performance Tester — browser client */

const $ = (id) => document.getElementById(id);

const els = {
  url: $('url'), method: $('method'), concurrency: $('concurrency'),
  durationSec: $('durationSec'), maxRequests: $('maxRequests'),
  thinkTimeMs: $('thinkTimeMs'), timeoutMs: $('timeoutMs'),
  headers: $('headers'), body: $('body'),
  followRedirects: $('followRedirects'), insecure: $('insecure'),
  startBtn: $('startBtn'), stopBtn: $('stopBtn'), formError: $('formError'),
  statusPill: $('statusPill'), progressBar: $('progressBar'), progressLabel: $('progressLabel'),
  stCompleted: $('stCompleted'), stInflight: $('stInflight'), stOk: $('stOk'),
  stFailed: $('stFailed'), stRps: $('stRps'), stAvgRps: $('stAvgRps'),
  stBytes: $('stBytes'), stElapsed: $('stElapsed'),
  latMin: $('latMin'), latMean: $('latMean'), latP50: $('latP50'),
  latP95: $('latP95'), latTtfb: $('latTtfb'),
  statusList: $('statusList'), errorList: $('errorList'),
  rpsChart: $('rpsChart'), latChart: $('latChart'),
};

let source = null;         // EventSource
let runId = null;
const rpsSeries = [];
const latSeries = [];

/* ---------- helpers ---------- */

function fmtNum(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmt1(n) { return Number(n).toFixed(1); }
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < units.length - 1);
  return `${b.toFixed(1)} ${units[i]}`;
}
function parseHeaders(text) {
  const out = {};
  text.split('\n').forEach((line) => {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
  });
  return out;
}
function setStatus(state, label) {
  els.statusPill.className = `pill ${state}`;
  els.statusPill.textContent = label;
}
function codeClass(code) {
  const c = String(code);
  if (c.startsWith('2')) return 'code-2xx';
  if (c.startsWith('3')) return 'code-3xx';
  if (c.startsWith('4')) return 'code-4xx';
  if (c.startsWith('5')) return 'code-5xx';
  return '';
}

/* ---------- tiny canvas line chart (no dependencies) ---------- */

function drawChart(canvas, series, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = 6;
  ctx.clearRect(0, 0, w, h);

  if (series.length < 2) return;
  const max = Math.max(...series, 1);
  const min = 0;
  const stepX = (w - pad * 2) / (series.length - 1);
  const scaleY = (h - pad * 2) / (max - min || 1);

  // gridline at max
  ctx.strokeStyle = '#2a3140';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(w - pad, pad); ctx.stroke();

  // area + line
  ctx.beginPath();
  series.forEach((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (v - min) * scaleY;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, pad, 0, h);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');
  ctx.lineTo(w - pad, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // max label
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px monospace';
  ctx.fillText(String(Math.round(max)), pad + 2, pad + 10);
}

/* ---------- UI updates ---------- */

function renderTick(s) {
  els.stCompleted.textContent = fmtNum(s.completed);
  els.stInflight.textContent = fmtNum(s.inFlight);
  els.stOk.textContent = fmtNum(s.ok);
  els.stFailed.textContent = fmtNum(s.failed);
  els.stRps.textContent = fmt1(s.rps);
  els.stAvgRps.textContent = fmt1(s.avgRps);
  els.stBytes.textContent = fmtBytes(s.bytes);
  els.stElapsed.textContent = (s.elapsedMs / 1000).toFixed(1) + 's';

  const lat = s.recentLatency || {};
  els.latMin.textContent = Math.round(lat.min ?? 0);
  els.latMean.textContent = Math.round(lat.mean ?? 0);
  els.latP50.textContent = Math.round(lat.p50 ?? 0);
  els.latP95.textContent = Math.round(lat.p95 ?? 0);
  els.latTtfb.textContent = Math.round(s.ttfbMean ?? 0);

  if (s.progress != null) {
    const pct = Math.round(s.progress * 100);
    els.progressBar.style.width = pct + '%';
    els.progressLabel.textContent = pct + '%';
  } else {
    els.progressBar.style.width = '100%';
    els.progressLabel.textContent = '∞';
  }

  renderDist(els.statusList, s.statusCounts, true);
  renderDist(els.errorList, s.errorCounts, false);

  rpsSeries.push(s.rps);
  latSeries.push(lat.p95 ?? 0);
  if (rpsSeries.length > 120) rpsSeries.shift();
  if (latSeries.length > 120) latSeries.shift();
  drawChart(els.rpsChart, rpsSeries, '#3b82f6');
  drawChart(els.latChart, latSeries, '#22d3ee');
}

function renderDist(ul, counts, isStatus) {
  const keys = Object.keys(counts || {});
  if (!keys.length) {
    ul.innerHTML = `<li class="muted">${isStatus ? 'No data yet' : 'None'}</li>`;
    return;
  }
  keys.sort((a, b) => counts[b] - counts[a]);
  ul.innerHTML = keys
    .map((k) => {
      const cls = isStatus ? codeClass(k) : 'code-5xx';
      return `<li><span class="${cls}">${k}</span><span>${fmtNum(counts[k])}</span></li>`;
    })
    .join('');
}

function renderDone(result) {
  setStatus('done', 'Finished');
  toggleRunning(false);
  const l = result.latency || {};
  els.latMin.textContent = Math.round(l.min ?? 0);
  els.latMean.textContent = Math.round(l.mean ?? 0);
  els.latP50.textContent = Math.round(l.p50 ?? 0);
  els.latP95.textContent = Math.round(l.p95 ?? 0);
  els.progressBar.style.width = '100%';
  els.progressLabel.textContent = '100%';
}

function toggleRunning(running) {
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
  [els.url, els.method, els.concurrency, els.durationSec, els.maxRequests,
   els.thinkTimeMs, els.timeoutMs, els.headers, els.body,
   els.followRedirects, els.insecure].forEach((el) => (el.disabled = running));
}

/* ---------- run control ---------- */

async function startTest() {
  els.formError.textContent = '';
  const url = els.url.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    els.formError.textContent = 'Enter a valid http:// or https:// URL.';
    return;
  }

  const config = {
    url,
    method: els.method.value,
    concurrency: Number(els.concurrency.value),
    durationSec: Number(els.durationSec.value),
    maxRequests: Number(els.maxRequests.value),
    thinkTimeMs: Number(els.thinkTimeMs.value),
    timeoutMs: Number(els.timeoutMs.value),
    headers: parseHeaders(els.headers.value),
    body: els.body.value || null,
    followRedirects: els.followRedirects.checked,
    insecure: els.insecure.checked,
  };

  rpsSeries.length = 0;
  latSeries.length = 0;

  let res;
  try {
    res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  } catch (e) {
    els.formError.textContent = 'Could not reach the local server.';
    return;
  }
  const data = await res.json();
  if (!res.ok) {
    els.formError.textContent = data.error || 'Failed to start.';
    return;
  }

  runId = data.runId;
  toggleRunning(true);
  setStatus('running', 'Running');
  openStream(runId);
}

function openStream(id) {
  if (source) source.close();
  source = new EventSource(`/api/stream?runId=${encodeURIComponent(id)}`);

  source.addEventListener('tick', (e) => renderTick(JSON.parse(e.data)));
  source.addEventListener('done', (e) => {
    renderDone(JSON.parse(e.data));
    source.close();
    source = null;
  });
  source.addEventListener('error', (e) => {
    if (e.data) {
      try { els.formError.textContent = JSON.parse(e.data).error || ''; } catch {}
    }
  });
  source.onerror = () => { /* auto-reconnect handled by EventSource */ };
}

async function stopTest() {
  els.stopBtn.disabled = true;
  setStatus('stopped', 'Stopping…');
  try {
    await fetch('/api/stop', { method: 'POST' });
  } catch { /* ignore */ }
  // The engine will emit a final 'done' event; UI resets there.
}

els.startBtn.addEventListener('click', startTest);
els.stopBtn.addEventListener('click', stopTest);
els.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') startTest(); });
