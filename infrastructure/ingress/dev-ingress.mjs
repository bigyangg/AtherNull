#!/usr/bin/env node
// Local single-origin ingress (ADR-0015). The real Agent Canvas, the
// AtherNull web app and apps/api must share ONE browser origin so the
// Better Auth session cookie reaches the agent gateway with no frontend
// changes (ADR-0006's same-origin finding). Production does the same path
// routing in its reverse proxy (Coolify/Traefik).
//
//   /canvas/**                     -> Agent Canvas (Vite, VITE_BASE_PATH=/canvas)
//   /oh/**, /api/auth/**, /v1/**,  -> apps/api (agent gateway, auth, AtherNull API)
//   /health
//   everything else                -> apps/web (Next.js)
//
// HTTP and WebSocket upgrades are both forwarded. No dependencies.
//
//   node infrastructure/ingress/dev-ingress.mjs
//   INGRESS_PORT=8080 API_PORT=3001 WEB_PORT=3000 CANVAS_PORT=3102
//   CANVAS_DIST=<agent canvas build dir>  serve a static canvas build
//                                         (built with VITE_BASE_PATH=/canvas)
//                                         instead of proxying to CANVAS_PORT

import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { extname, join, normalize, sep } from "node:path";

const PORT = Number(process.env.INGRESS_PORT ?? 8080);
const API = Number(process.env.API_PORT ?? 3001);
const WEB = Number(process.env.WEB_PORT ?? 3000);
const CANVAS = Number(process.env.CANVAS_PORT ?? 3102);
const CANVAS_DIST = process.env.CANVAS_DIST ? normalize(process.env.CANVAS_DIST) : null;

// While a backend process is restarting (or the canvas is being rebuilt):
// a branded page for browsers, a JSON error for API callers. Never a crash,
// never a bare text line. Reloads itself after a few seconds.
const UNAVAILABLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="8">
<title>Back in a moment | AtherNull</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#fff;color:#131319;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{max-width:520px}p.k{margin:0;color:#5143c8;font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
h1{margin:14px 0 0;font-size:40px;letter-spacing:-.04em;line-height:1.05}p.m{margin:16px 0 0;color:#555560;line-height:1.6}
a{display:inline-block;margin-top:26px;color:#fff;background:#131319;border-radius:999px;padding:10px 18px;font-weight:600;text-decoration:none}
@media(prefers-color-scheme:dark){body{background:#141414;color:#ececf1}p.m{color:#a1a1aa}a{background:#ececf1;color:#141414}}
</style></head><body><main><p class="k">AtherNull</p><h1>We'll be right back.</h1>
<p class="m">AtherNull is restarting or updating. Your builds, payments and conversations are safe. This page reloads by itself in a few seconds.</p>
<a href="/">Reload</a></main></body></html>`;

function wantsJson(req) {
  const url = req.url ?? "/";
  return /^\/(v1|oh|api|health)(\/|\?|$)/.test(url) || (req.headers.accept ?? "").includes("application/json");
}

function unavailable(req, res, status = 503) {
  if (res.headersSent) return res.end();
  if (wantsJson(req)) {
    res.writeHead(status, { "content-type": "application/json", "retry-after": "5", "cache-control": "no-store" });
    return res.end(JSON.stringify({ error: "AtherNull is restarting. Try again in a few seconds." }));
  }
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "retry-after": "5", "cache-control": "no-store" });
  res.end(UNAVAILABLE_HTML);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".wasm": "application/wasm", ".map": "application/json",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain",
};

// Static canvas: /canvas/<file>, falling back to index.html (SPA routes).
function serveCanvas(req, res) {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0].replace(/^\/canvas/, "")) || "/";
  let file = normalize(join(CANVAS_DIST, rel));
  if (!file.startsWith(CANVAS_DIST + sep) && file !== CANVAS_DIST) file = CANVAS_DIST;
  let stat;
  try {
    stat = statSync(file);
    if (stat.isDirectory()) throw new Error("dir");
  } catch {
    file = join(CANVAS_DIST, "index.html");
    try {
      stat = statSync(file);
    } catch {
      // The canvas is being rebuilt (its build directory is replaced): answer
      // "try again", never crash the ingress.
      return unavailable(req, res, 503);
    }
  }
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

function targetPort(url = "/") {
  if (url === "/canvas" || url.startsWith("/canvas/") || url.startsWith("/canvas?")) return CANVAS;
  if (/^\/(oh|v1|preview)(\/|\?|$)/.test(url) || url.startsWith("/api/auth/") || url === "/health") return API;
  return WEB;
}

const server = http.createServer((req, res) => {
  const port = targetPort(req.url);
  if (port === CANVAS && CANVAS_DIST) return serveCanvas(req, res);
  const upstream = http.request(
    { host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => unavailable(req, res, 502));
  req.pipe(upstream);
});

// WebSocket (and any other) upgrades: replay the request head to the target
// and splice the two TCP streams.
server.on("upgrade", (req, socket, head) => {
  const port = targetPort(req.url);
  const upstream = net.connect(port, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const drop = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", drop);
  socket.on("error", drop);
});

server.listen(PORT, process.env.INGRESS_HOST ?? "127.0.0.1", () => {
  console.log(`ingress on http://localhost:${PORT}  (canvas ${CANVAS_DIST ?? `:${CANVAS}`}, api :${API}, web :${WEB})`);
});
