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
    stat = statSync(file);
  }
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
}

function targetPort(url = "/") {
  if (url === "/canvas" || url.startsWith("/canvas/") || url.startsWith("/canvas?")) return CANVAS;
  if (/^\/(oh|v1)(\/|\?|$)/.test(url) || url.startsWith("/api/auth/") || url === "/health") return API;
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
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`ingress: upstream :${port} unavailable`);
  });
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
