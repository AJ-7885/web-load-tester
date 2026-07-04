#!/usr/bin/env node
'use strict';

/**
 * Web Load & Performance Tester — CLI
 *
 * Usage:
 *   node cli.js <url> [options]
 *
 * Options:
 *   -c, --concurrency <n>   Concurrent workers (default 10)
 *   -d, --duration <sec>    Run for N seconds (default 10; 0 = until Ctrl+C)
 *   -n, --requests <n>      Stop after N requests (0 = unlimited)
 *   -m, --method <verb>     HTTP method (default GET)
 *   -t, --timeout <ms>      Per-request timeout (default 10000)
 *       --think <ms>        Delay between requests per worker (default 0)
 *   -H, --header <k:v>      Add a header (repeatable)
 *   -b, --body <string>     Request body for POST/PUT/PATCH
 *       --no-redirect       Do not follow redirects
 *       --insecure          Allow self-signed TLS certificates
 *   -h, --help              Show this help
 */

const { LoadTester } = require('./engine');

function parseArgs(argv) {
  const opts = { headers: {} };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-c': case '--concurrency': opts.concurrency = Number(next()); break;
      case '-d': case '--duration': opts.durationSec = Number(next()); break;
      case '-n': case '--requests': opts.maxRequests = Number(next()); break;
      case '-m': case '--method': opts.method = next(); break;
      case '-t': case '--timeout': opts.timeoutMs = Number(next()); break;
      case '--think': opts.thinkTimeMs = Number(next()); break;
      case '-b': case '--body': opts.body = next(); break;
      case '-H': case '--header': {
        const h = next(); const idx = h.indexOf(':');
        if (idx > 0) opts.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
        break;
      }
      case '--no-redirect': opts.followRedirects = false; break;
      case '--insecure': opts.insecure = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(1); }
        positional.push(a);
    }
  }
  opts.url = positional[0];
  return opts;
}

function printHelp() {
  console.log(`
Web Load & Performance Tester (CLI)

  node cli.js <url> [options]

Options:
  -c, --concurrency <n>   Concurrent workers (default 10)
  -d, --duration <sec>    Run for N seconds (default 10; 0 = until Ctrl+C)
  -n, --requests <n>      Stop after N requests (0 = unlimited)
  -m, --method <verb>     HTTP method (default GET)
  -t, --timeout <ms>      Per-request timeout (default 10000)
      --think <ms>        Delay between requests per worker
  -H, --header <k:v>      Add a header (repeatable)
  -b, --body <string>     Request body for POST/PUT/PATCH
      --no-redirect       Do not follow redirects
      --insecure          Allow self-signed TLS certificates
  -h, --help              Show this help

Only test servers you own or are authorized to test.

Example:
  node cli.js http://localhost:3000/ -c 25 -d 20
`);
}

function bar(pct, width = 24) {
  const filled = Math.round((pct || 0) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(1)} ${u[i]}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.url) { printHelp(); process.exit(opts.url ? 0 : 1); }

  if (opts.durationSec === undefined && opts.maxRequests === undefined) opts.durationSec = 10;

  let tester;
  try {
    tester = new LoadTester(opts);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }

  const cfg = tester.cfg;
  console.log(`\n  ${cfg.method} ${cfg.url}`);
  console.log(`  concurrency=${cfg.concurrency}  ` +
    `${cfg.durationSec ? 'duration=' + cfg.durationSec + 's  ' : ''}` +
    `${cfg.maxRequests ? 'requests=' + cfg.maxRequests + '  ' : ''}\n`);

  const isTTY = process.stdout.isTTY;
  tester.on('tick', (s) => {
    if (s.done) return;
    const line =
      `  ${bar(s.progress)} ` +
      `${s.completed.toString().padStart(7)} done  ` +
      `${s.rps.toFixed(0).padStart(5)} rps  ` +
      `p95 ${Math.round(s.recentLatency.p95).toString().padStart(5)}ms  ` +
      `ok ${s.ok} / fail ${s.failed}`;
    if (isTTY) process.stdout.write('\r' + line + ' '.repeat(4));
    else console.log(line);
  });

  process.on('SIGINT', () => {
    if (isTTY) process.stdout.write('\n  stopping…\n');
    tester.stop();
  });

  const r = await tester.start();
  if (isTTY) process.stdout.write('\n');

  const l = r.latency;
  console.log('\n  ── Summary ───────────────────────────────');
  console.log(`  Duration        ${(r.elapsedMs / 1000).toFixed(1)} s`);
  console.log(`  Completed       ${r.completed}`);
  console.log(`  Success (2/3xx) ${r.ok}`);
  console.log(`  Failed          ${r.failed}`);
  console.log(`  Throughput      ${r.avgRps.toFixed(1)} req/s`);
  console.log(`  Data received   ${fmtBytes(r.bytes)}`);
  console.log(`  Latency (ms)    min ${Math.round(l.min)}  mean ${Math.round(l.mean)}  ` +
    `p50 ${Math.round(l.p50)}  p90 ${Math.round(l.p90)}  p95 ${Math.round(l.p95)}  p99 ${Math.round(l.p99)}  max ${Math.round(l.max)}`);
  console.log(`  TTFB mean       ${Math.round(r.ttfb.mean)} ms`);

  const codes = Object.keys(r.statusCounts);
  if (codes.length) {
    console.log('  Status codes    ' + codes.sort().map((c) => `${c}:${r.statusCounts[c]}`).join('  '));
  }
  const errs = Object.keys(r.errorCounts);
  if (errs.length) {
    console.log('  Errors          ' + errs.map((e) => `${e}:${r.errorCounts[e]}`).join('  '));
  }
  console.log('  ──────────────────────────────────────────\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
