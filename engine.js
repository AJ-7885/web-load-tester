'use strict';

/**
 * Web Load & Performance Tester — engine
 *
 * A dependency-free load generator built on Node's http/https modules.
 * It fires concurrent requests at a URL YOU CONTROL and measures latency,
 * throughput, status codes and errors. Designed for testing your own
 * infrastructure — not for generating fake traffic against third parties.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { EventEmitter } = require('events');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const SAMPLE_CAP = 200000; // max latency samples kept for exact-ish percentiles

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const frac = rank - low;
  return sorted[low] * (1 - frac) + sorted[high] * frac;
}

/** Bounded, reservoir-sampled collection of numbers for percentile math. */
class Samples {
  constructor(cap = SAMPLE_CAP) {
    this.cap = cap;
    this.count = 0;
    this.values = [];
    this.min = Infinity;
    this.max = -Infinity;
    this.sum = 0;
  }
  add(v) {
    this.count++;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    if (this.values.length < this.cap) {
      this.values.push(v);
    } else {
      // reservoir sampling keeps the sample representative without unbounded memory
      const j = Math.floor(Math.random() * this.count);
      if (j < this.cap) this.values[j] = v;
    }
  }
  summary() {
    if (!this.count) {
      return { min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
    }
    const sorted = this.values.slice().sort((a, b) => a - b);
    return {
      min: this.min,
      max: this.max,
      mean: this.sum / this.count,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    };
  }
}

/** Small ring buffer used for "current" (recent-window) latency stats. */
class RingBuffer {
  constructor(size = 2048) {
    this.size = size;
    this.buf = [];
    this.idx = 0;
  }
  add(v) {
    if (this.buf.length < this.size) this.buf.push(v);
    else this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % this.size;
  }
  stats() {
    if (!this.buf.length) return { p50: 0, p95: 0, mean: 0 };
    const sorted = this.buf.slice().sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), mean };
  }
}

function normalizeConfig(raw = {}) {
  const cfg = {
    url: String(raw.url || '').trim(),
    method: String(raw.method || 'GET').toUpperCase(),
    concurrency: clampInt(raw.concurrency, 1, 5000, 10),
    durationSec: clampInt(raw.durationSec, 0, 86400, 0),
    maxRequests: clampInt(raw.maxRequests, 0, 100000000, 0),
    thinkTimeMs: clampInt(raw.thinkTimeMs, 0, 3600000, 0),
    timeoutMs: clampInt(raw.timeoutMs, 100, 600000, 10000),
    followRedirects: raw.followRedirects !== false,
    maxRedirects: clampInt(raw.maxRedirects, 0, 20, 5),
    insecure: Boolean(raw.insecure),
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
    body: raw.body != null ? String(raw.body) : null,
    tickMs: clampInt(raw.tickMs, 100, 5000, 500),
  };

  if (!cfg.url) throw new Error('A target URL is required.');
  let parsed;
  try {
    parsed = new URL(cfg.url);
  } catch {
    throw new Error(`Invalid URL: ${cfg.url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://');
  }
  // If neither a duration nor a request cap is set the test runs until stopped.
  return cfg;
}

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

class LoadTester extends EventEmitter {
  constructor(config) {
    super();
    this.cfg = normalizeConfig(config);
    this.stopped = false;
    this.started = false;
    this.startedCount = 0; // requests dispatched (used to enforce maxRequests)
    this.inFlight = 0;

    this.completed = 0;
    this.ok = 0;
    this.failed = 0;
    this.bytes = 0;

    this.statusCounts = Object.create(null);
    this.errorCounts = Object.create(null);

    this.latency = new Samples();
    this.ttfb = new Samples();
    this.recent = new RingBuffer();

    this.startTime = 0;
    this.lastTickTime = 0;
    this.lastTickCompleted = 0;
    this.history = []; // [{ t, rps, p95 }]

    const Agent = this.cfg.url.startsWith('https') ? https.Agent : http.Agent;
    this.agent = new Agent({
      keepAlive: this.cfg.thinkTimeMs === 0,
      maxSockets: this.cfg.concurrency,
      maxFreeSockets: this.cfg.concurrency,
    });
  }

  start() {
    if (this.started) throw new Error('Already started.');
    this.started = true;
    this.startTime = Date.now();
    this.lastTickTime = this.startTime;

    if (this.cfg.durationSec > 0) {
      this.durationTimer = setTimeout(() => this.stop(), this.cfg.durationSec * 1000);
    }
    this.ticker = setInterval(() => this._emitTick(false), this.cfg.tickMs);

    const workers = [];
    for (let i = 0; i < this.cfg.concurrency; i++) workers.push(this._worker());

    this._finalPromise = Promise.all(workers).then(() => this._finish());
    return this._finalPromise;
  }

  stop() {
    this.stopped = true;
  }

  _reserveSlot() {
    if (this.stopped) return false;
    if (this.cfg.maxRequests > 0 && this.startedCount >= this.cfg.maxRequests) return false;
    this.startedCount++;
    return true;
  }

  async _worker() {
    while (this._reserveSlot()) {
      await this._doRequest(this.cfg.url, this.cfg.method, this.cfg.maxRedirects);
      if (this.cfg.thinkTimeMs > 0 && !this.stopped) await sleep(this.cfg.thinkTimeMs);
    }
  }

  _doRequest(urlStr, method, redirectsLeft) {
    return new Promise((resolve) => {
      let parsed;
      try {
        parsed = new URL(urlStr);
      } catch {
        this._recordError('EBADURL');
        return resolve();
      }

      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const headers = Object.assign(
        { 'User-Agent': 'web-load-tester/1.0', Accept: '*/*' },
        this.cfg.headers
      );

      let bodyBuf = null;
      if (this.cfg.body != null && method !== 'GET' && method !== 'HEAD') {
        bodyBuf = Buffer.from(this.cfg.body);
        if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = String(bodyBuf.length);
      }

      const options = {
        method,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
        agent: this.agent,
        timeout: this.cfg.timeoutMs,
      };
      if (isHttps && this.cfg.insecure) options.rejectUnauthorized = false;

      this.inFlight++;
      const startNs = process.hrtime.bigint();
      let firstByteMs = null;
      let settled = false;

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        this.inFlight--;
        fn();
        resolve();
      };

      const req = lib.request(options, (res) => {
        res.once('data', () => {
          if (firstByteMs === null) {
            firstByteMs = Number(process.hrtime.bigint() - startNs) / 1e6;
          }
        });
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
        });
        res.on('end', () => {
          const totalMs = Number(process.hrtime.bigint() - startNs) / 1e6;

          // Follow redirects when asked to.
          if (
            this.cfg.followRedirects &&
            REDIRECT_CODES.has(res.statusCode) &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            const nextUrl = new URL(res.headers.location, urlStr).toString();
            const nextMethod = res.statusCode === 303 ? 'GET' : method;
            finish(() => {});
            // Count the redirect hop, then chase the target.
            this._doRequest(nextUrl, nextMethod, redirectsLeft - 1);
            return;
          }

          finish(() => {
            this.bytes += received;
            this.latency.add(totalMs);
            this.recent.add(totalMs);
            if (firstByteMs !== null) this.ttfb.add(firstByteMs);
            this.completed++;
            const code = res.statusCode;
            this.statusCounts[code] = (this.statusCounts[code] || 0) + 1;
            if (code >= 200 && code < 400) this.ok++;
            else this.failed++;
          });
        });
        res.on('error', () => finish(() => this._tallyError('ERESPONSE')));
      });

      req.on('error', (err) => finish(() => this._tallyError(err.code || 'EREQUEST')));
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
        finish(() => this._tallyError('ETIMEDOUT'));
      });

      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  _tallyError(code) {
    this.completed++;
    this.failed++;
    this.errorCounts[code] = (this.errorCounts[code] || 0) + 1;
  }

  _recordError(code) {
    this.startedCount = this.startedCount; // no-op guard for clarity
    this._tallyError(code);
  }

  _snapshot(done) {
    const now = Date.now();
    const elapsedMs = now - this.startTime;
    const intervalMs = Math.max(1, now - this.lastTickTime);
    const intervalCompleted = this.completed - this.lastTickCompleted;
    const rps = (intervalCompleted / intervalMs) * 1000;
    const avgRps = elapsedMs > 0 ? (this.completed / elapsedMs) * 1000 : 0;

    const recent = this.recent.stats();

    let progress = null;
    if (this.cfg.maxRequests > 0) {
      progress = Math.min(1, this.completed / this.cfg.maxRequests);
    } else if (this.cfg.durationSec > 0) {
      progress = Math.min(1, elapsedMs / (this.cfg.durationSec * 1000));
    }

    return {
      done: !!done,
      elapsedMs,
      sent: this.startedCount,
      completed: this.completed,
      inFlight: this.inFlight,
      ok: this.ok,
      failed: this.failed,
      bytes: this.bytes,
      rps,
      avgRps,
      progress,
      recentLatency: recent,
      statusCounts: Object.assign({}, this.statusCounts),
      errorCounts: Object.assign({}, this.errorCounts),
      ttfbMean: this.ttfb.count ? this.ttfb.sum / this.ttfb.count : 0,
    };
  }

  _emitTick(done) {
    const snap = this._snapshot(done);
    this.history.push({ t: snap.elapsedMs, rps: snap.rps, p95: snap.recentLatency.p95 });
    if (this.history.length > 5000) this.history.shift();
    this.lastTickTime = Date.now();
    this.lastTickCompleted = this.completed;
    this.emit('tick', snap);
  }

  summary() {
    const snap = this._snapshot(true);
    return {
      config: this.cfg,
      elapsedMs: snap.elapsedMs,
      completed: this.completed,
      ok: this.ok,
      failed: this.failed,
      bytes: this.bytes,
      avgRps: snap.avgRps,
      latency: this.latency.summary(),
      ttfb: this.ttfb.summary(),
      statusCounts: snap.statusCounts,
      errorCounts: snap.errorCounts,
      history: this.history,
    };
  }

  _finish() {
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.ticker) clearInterval(this.ticker);
    this.stopped = true;
    this._emitTick(true);
    const result = this.summary();
    this.agent.destroy();
    this.emit('done', result);
    return result;
  }
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
}

module.exports = { LoadTester, normalizeConfig, percentile };
