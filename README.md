# Web Load & Performance Tester

A small, **cross-platform** (macOS / Linux / Windows) HTTP load & performance
tester with a live browser dashboard **and** a terminal CLI. Built entirely on
Node.js standard library — **no npm dependencies to install**.

This is the modern, legitimate replacement for the old Windows "Web Traffic
Generator" WinForms app: instead of pushing fake visits at third-party sites
through public proxies, it measures how **your own** server behaves under
concurrent load.

> ⚠️ **Authorized use only.** Only run this against servers you own or have
> explicit written permission to test. Sending high-volume traffic to systems
> you don't control can be abusive and may be illegal.

---

## Requirements

- Node.js 18+ (you have v22). Check with `node --version`.

## Run the web UI (recommended)

```bash
cd ~/web-load-tester
npm start
```

Then open **http://127.0.0.1:4321** in your browser.

1. Enter a **Target URL** you control (e.g. `http://localhost:3000/`).
2. Set **Concurrency** and either a **Duration** or a **Max requests** cap.
3. Click **Start test** and watch live throughput, latency percentiles,
   status-code and error breakdowns, and two live charts.
4. Click **Stop** at any time.

Change the port: `PORT=8080 npm start`.

## Run from the terminal (CLI)

```bash
node cli.js http://localhost:3000/ -c 25 -d 20
```

Common options:

| Flag | Meaning | Default |
| --- | --- | --- |
| `-c, --concurrency <n>` | concurrent workers | 10 |
| `-d, --duration <sec>` | run for N seconds (0 = until Ctrl+C) | 10 |
| `-n, --requests <n>` | stop after N requests | 0 (unlimited) |
| `-m, --method <verb>` | HTTP method | GET |
| `-t, --timeout <ms>` | per-request timeout | 10000 |
| `--think <ms>` | delay between requests per worker | 0 |
| `-H, --header <k:v>` | add a header (repeatable) | — |
| `-b, --body <string>` | request body (POST/PUT/PATCH) | — |
| `--no-redirect` | don't follow redirects | follows |
| `--insecure` | allow self-signed TLS | off |

Example with headers and a POST body:

```bash
node cli.js https://api.example.internal/orders \
  -m POST -c 50 -d 30 \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -b '{"sku":"ABC","qty":1}'
```

## What it measures

- **Throughput**: requests/second (instantaneous and average)
- **Latency**: min / mean / p50 / p90 / p95 / p99 / max (ms)
- **TTFB**: mean time-to-first-byte
- **Outcomes**: 2xx/3xx vs failures, full status-code distribution
- **Errors**: connection refused, timeouts, DNS, TLS, etc.
- **Data**: total bytes received

## Project layout

```
web-load-tester/
├── engine.js        # dependency-free load engine (used by server + CLI)
├── server.js        # localhost web server + SSE live streaming
├── cli.js           # terminal interface
├── package.json
└── public/          # browser dashboard (index.html, styles.css, app.js)
```

## How it differs from the old Windows tool

| Old "Web Traffic Generator" | This tool |
| --- | --- |
| IE `WebBrowser` ActiveX control (Windows only) | Node `http`/`https`, cross-platform |
| Rotated public proxies to fake unique visitors | Direct requests to a host you control |
| Deleted cookies / killed sessions to evade analytics | Honest, labeled `User-Agent`, no evasion |
| Goal: inflate someone's traffic counters | Goal: measure your server's real performance |

## Notes

- The server binds to `127.0.0.1` only — it is not exposed to your network.
- Percentiles use reservoir sampling so memory stays bounded on long runs.
- One test runs at a time; start another after the current one finishes/stops.
