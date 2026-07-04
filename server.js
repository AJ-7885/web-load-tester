'use strict';

/**
 * Web Load & Performance Tester — local server
 *
 * Serves the browser UI and runs load tests on the backend (so there are no
 * browser CORS limits). Binds to localhost only. Live metrics are streamed to
 * the UI via Server-Sent Events (SSE). Zero external dependencies.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { LoadTester } = require('./engine');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4321;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Only one active run at a time keeps the tool simple and predictable.
let currentRun = null; // { id, tester, latest, subscribers:Set<res>, done, result }

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function broadcast(run, event, data) {
  const payload =
    (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of run.subscribers) {
    try {
      res.write(payload);
    } catch {
      /* subscriber gone; cleaned up on close */
    }
  }
}

async function handleStart(req, res) {
  if (currentRun && !currentRun.done) {
    return sendJSON(res, 409, { error: 'A test is already running. Stop it first.' });
  }
  let config;
  try {
    config = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJSON(res, 400, { error: 'Invalid JSON body.' });
  }

  let tester;
  try {
    tester = new LoadTester(config);
  } catch (err) {
    return sendJSON(res, 400, { error: err.message });
  }

  const run = {
    id: randomUUID(),
    tester,
    latest: null,
    subscribers: new Set(),
    done: false,
    result: null,
  };
  currentRun = run;

  tester.on('tick', (snap) => {
    run.latest = snap;
    broadcast(run, 'tick', snap);
  });
  tester.on('done', (result) => {
    run.done = true;
    run.result = result;
    broadcast(run, 'done', result);
    // Give SSE clients a moment to receive 'done', then close their streams.
    setTimeout(() => {
      for (const s of run.subscribers) {
        try { s.end(); } catch {}
      }
      run.subscribers.clear();
    }, 250);
  });

  tester.start().catch((err) => {
    broadcast(run, 'error', { error: String(err && err.message || err) });
  });

  const { url, method, concurrency, durationSec, maxRequests } = tester.cfg;
  console.log(
    `[start] ${method} ${url}  c=${concurrency} ` +
    `${durationSec ? durationSec + 's' : ''}${maxRequests ? ' ' + maxRequests + ' reqs' : ''}`.trim()
  );
  sendJSON(res, 200, { runId: run.id });
}

function handleStream(req, res, runId) {
  if (!currentRun || currentRun.id !== runId) {
    return sendJSON(res, 404, { error: 'No such run.' });
  }
  const run = currentRun;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  run.subscribers.add(res);

  // Immediately push the latest snapshot so a late subscriber sees current state.
  if (run.latest) res.write(`event: tick\ndata: ${JSON.stringify(run.latest)}\n\n`);
  if (run.done && run.result) res.write(`event: done\ndata: ${JSON.stringify(run.result)}\n\n`);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    run.subscribers.delete(res);
  });
}

async function handleStop(req, res) {
  if (!currentRun || currentRun.done) {
    return sendJSON(res, 200, { stopped: false, message: 'No active test.' });
  }
  currentRun.tester.stop();
  console.log('[stop] requested by user');
  sendJSON(res, 200, { stopped: true });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'POST' && p === '/api/start') return handleStart(req, res);
  if (req.method === 'POST' && p === '/api/stop') return handleStop(req, res);
  if (req.method === 'GET' && p === '/api/stream') {
    return handleStream(req, res, url.searchParams.get('runId'));
  }
  if (req.method === 'GET') return serveStatic(req, res, p);

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method Not Allowed');
});

server.listen(PORT, HOST, () => {
  console.log('\n  Web Load & Performance Tester');
  console.log('  --------------------------------');
  console.log(`  Open:  http://${HOST}:${PORT}`);
  console.log('  Only test sites you own or are authorized to test.\n');
});
