// Live previews: a verified build's static web app, visitable at
// /preview/<taskId>/. The independent verifier builds it from the exact
// commit it just tested (never the worker's copy) and uploads the files;
// they are served here only while the build is verified or later.
//
// Isolation: every response carries `Content-Security-Policy: sandbox`
// without allow-same-origin, so the page runs in an opaque origin even though
// it shares athernull.io's host. Its requests carry `Origin: null` and no
// AtherNull cookies, so customer code can never act as the viewer; it can
// run scripts, forms and popups, but not read or write AtherNull state.
// localStorage/cookies are unavailable to the app itself (opaque origin).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { db } from "../db.js";
import { requireVerifierToken } from "./verification.js";

const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil(MAX_TOTAL_BYTES * 1.4) + 1024 * 1024; // base64 overhead

/** Task states in which a build's preview is visible: verified, and after. */
export const PREVIEWABLE_STATUSES = new Set([
  "AWAITING_ACCEPTANCE",
  "ACCEPTED",
  "SETTLING",
  "SETTLED",
  "DELIVERED",
  "DISPUTED",
]);

export function previewsRoot(): string {
  return resolve(process.env.PREVIEWS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".data", "previews"));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function previewDir(taskId: string): string {
  return join(previewsRoot(), taskId.toLowerCase());
}

/** True when a preview has been published for the task (regardless of its status). */
export function hasPreview(taskId: string): boolean {
  return UUID.test(taskId) && existsSync(join(previewDir(taskId), "index.html"));
}

/**
 * A safe relative path inside a preview: forward slashes, no empty, "." or
 * ".." segments, no drive letters or backslashes, printable characters only.
 */
export function safePreviewPath(path: string): string | null {
  if (path.length === 0 || path.length > 300) return null;
  if (path.startsWith("/") || path.includes("\\") || path.includes(":") || /[\x00-\x1f\x7f]/.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments.join("/");
}

const UploadBody = z.object({
  verifierId: z.string().min(1),
  files: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .min(1)
    .max(MAX_FILES),
});

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

function securityHeaders(reply: FastifyReply) {
  reply
    .header("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads")
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .header("Cross-Origin-Resource-Policy", "cross-origin")
    // The sandboxed page is an opaque origin: its module scripts and fonts
    // are CORS requests, so they need this (no credentials are ever allowed).
    .header("Access-Control-Allow-Origin", "*")
    .header("Cache-Control", "no-cache");
}

export async function previewRoutes(app: FastifyInstance) {
  // The verifier publishes the static site it built from the verified commit.
  app.post("/internal/verifications/:executionId/preview", { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    if (!requireVerifierToken(request, reply)) return;
    const { executionId } = z.object({ executionId: z.string() }).parse(request.params);
    const parsed = UploadBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { verifierId, files } = parsed.data;

    const patch = await db
      .selectFrom("execution_patches")
      .select(["task_id", "verify_lease_owner"])
      .where("execution_id", "=", executionId)
      .executeTakeFirst();
    if (!patch) return reply.status(404).send({ error: "Not found" });
    if (patch.verify_lease_owner !== verifierId) return reply.status(409).send({ error: "Verification is not claimed by this verifier" });

    const decoded: { path: string; data: Buffer }[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const file of files) {
      const path = safePreviewPath(file.path);
      if (!path) return reply.status(400).send({ error: `Unsafe preview path: ${file.path.slice(0, 100)}` });
      if (seen.has(path.toLowerCase())) return reply.status(400).send({ error: `Duplicate preview path: ${path}` });
      seen.add(path.toLowerCase());
      const data = Buffer.from(file.content, "base64");
      total += data.length;
      if (total > MAX_TOTAL_BYTES) return reply.status(413).send({ error: "Preview is too large" });
      decoded.push({ path, data });
    }
    if (!seen.has("index.html")) return reply.status(400).send({ error: "A preview needs an index.html at its root" });

    // Written beside the final directory, then swapped in: a reader never
    // sees a half-written preview.
    const target = previewDir(patch.task_id);
    const staging = `${target}.${randomUUID()}.tmp`;
    try {
      for (const { path, data } of decoded) {
        const out = join(staging, ...path.split("/"));
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, data);
      }
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
    request.log.info({ taskId: patch.task_id, files: decoded.length, bytes: total }, "published build preview");
    return reply.send({ taskId: patch.task_id, files: decoded.length, bytes: total, url: `/preview/${patch.task_id}/` });
  });

  // Relative asset paths need the trailing slash.
  app.get("/preview/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (!UUID.test(taskId)) return reply.status(404).send("Not found");
    return reply.redirect(`/preview/${taskId}/`, 308);
  });

  app.get("/preview/:taskId/*", async (request, reply) => {
    const { taskId } = request.params as { taskId: string; "*": string };
    securityHeaders(reply);
    if (!UUID.test(taskId)) return reply.status(404).type("text/plain").send("Not found");

    const task = await db.selectFrom("tasks").select("status").where("id", "=", taskId).executeTakeFirst();
    if (!task || !PREVIEWABLE_STATUSES.has(task.status) || !hasPreview(taskId)) {
      return reply.status(404).type("text/plain").send("This build has no live preview yet.");
    }

    const root = previewDir(taskId);
    let rel = (request.params as { "*": string })["*"] ?? "";
    try {
      rel = decodeURIComponent(rel);
    } catch {
      return reply.status(400).type("text/plain").send("Bad path");
    }
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const safe = safePreviewPath(rel);
    let file = safe ? resolve(root, ...safe.split("/")) : null;
    if (file && !file.startsWith(root + sep)) file = null;

    let found = file ? await stat(file).catch(() => null) : null;
    if (found?.isDirectory() && file) {
      file = join(file, "index.html");
      found = await stat(file).catch(() => null);
    }
    // Client-side routes (no file extension) fall back to the app's index.html.
    if ((!found || !found.isFile()) && !extname(rel)) {
      file = join(root, "index.html");
      found = await stat(file).catch(() => null);
    }
    if (!file || !found || !found.isFile()) return reply.status(404).type("text/plain").send("Not found");

    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    return reply.type(type).send(await readFile(file));
  });
}
