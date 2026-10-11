// ADR-0015 — the agent gateway: the ONLY backend the real OpenHands Agent
// Canvas talks to. Mounted at /oh, so the canvas's backend host is
// `<origin>/oh` and every Agent Server path is proxied as /oh/<path>.
//
// Per request: Better Auth session + org membership (the browser's own
// cookie — the canvas is served same-origin), Origin check on anything that
// mutates, the access policy (agent-gateway/policy.ts), then the org's own
// sandbox is called with its session key injected here. The browser never
// holds that key: whatever key the canvas sends is dropped.
//
// Both sockets the canvas opens (/sockets/events/:id, /sockets/bash-events)
// are terminated here and re-opened upstream with the real key; the
// browser's own auth frame is discarded, and chat frames on the events
// socket go through the same funding gate as POST .../events.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebSocket, type RawData } from "ws";

import {
  admitDiscussionMessage,
  forgetDiscussion,
  startDiscussion,
} from "../agent-gateway/discussions.js";
import { loadOrgServer, type OrgServer } from "../agent-gateway/org-server.js";
import { classifyGatewayRequest, DISCUSSION_ACTIONS } from "../agent-gateway/policy.js";
import { db } from "../db.js";
import { attachHeartbeat } from "../realtime/heartbeat.js";
import { HttpError, hasPrivilegedRole, requireOrgSession, sendHttpError } from "../session.js";
import { isTrustedOrigin } from "../trusted-origins.js";

const PREFIX = "/oh";
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const MAX_WS_FRAME_BYTES = 1024 * 1024;

// Request headers forwarded upstream; everything else (cookies, the
// canvas's own key, auth headers) stays behind.
const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "accept-language", "range", "if-none-match"];
// Response headers never copied back.
const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "set-cookie",
  "access-control-allow-origin",
  "access-control-allow-credentials",
]);

const normalizeId = (id: string) => id.replace(/-/g, "").toLowerCase();

// The funding gate: agent work is only allowed on a conversation that is
// the live execution of this org's funded build.
async function assertFundedRunningConversation(conversationId: string, organizationId: string): Promise<void> {
  const rows = await db
    .selectFrom("executions")
    .innerJoin("tasks", "tasks.id", "executions.task_id")
    .select(["executions.conversation_id", "executions.status as executionStatus", "tasks.status as taskStatus"])
    .where("tasks.organization_id", "=", organizationId)
    .where("executions.conversation_id", "is not", null)
    .where("tasks.status", "=", "RUNNING")
    .execute();
  const match = rows.find((r) => r.conversation_id && normalizeId(r.conversation_id) === normalizeId(conversationId));
  if (!match) {
    throw new HttpError(402, "The agent only works inside a funded AtherNull build that is currently running");
  }
}

// Agent work on one conversation: a discussion accepts chat from any
// member (within its caps); anything else needs owner/admin AND a funded,
// running build.
async function authorizeConversationWork(conversationId: string, action: string, organizationId: string, role: string) {
  if (DISCUSSION_ACTIONS.has(action)) {
    const admitted = await admitDiscussionMessage(conversationId, organizationId);
    if (admitted) return;
  }
  if (!hasPrivilegedRole(role)) throw new HttpError(403, "Only organization owners and admins can direct a build");
  await assertFundedRunningConversation(conversationId, organizationId);
}

async function authorize(request: FastifyRequest, method: string, path: string) {
  const { organizationId, role, userId } = await requireOrgSession(request);
  if (method !== "GET" && method !== "HEAD" && !isTrustedOrigin(request.headers.origin)) {
    throw new HttpError(403, "Untrusted origin");
  }
  const access = classifyGatewayRequest(method, path);
  if (access.kind === "blocked") throw new HttpError(403, access.reason);
  if (access.kind === "agent") {
    await authorizeConversationWork(access.conversationId, access.action, organizationId, role);
  } else if (access.kind === "control" && !hasPrivilegedRole(role)) {
    throw new HttpError(403, "Only organization owners and admins can change the agent sandbox");
  }
  return { organizationId, role, userId, access };
}

function upstreamPath(request: FastifyRequest): string {
  const raw = request.raw.url ?? "/";
  return raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) || "/" : raw;
}

async function proxyHttp(request: FastifyRequest, reply: FastifyReply) {
  const method = request.method.toUpperCase();
  const path = upstreamPath(request);
  const { organizationId, userId, access } = await authorize(request, method, path);
  const server = await loadOrgServer(organizationId);
  if (access.kind === "discuss") return startDiscussionUpstream(reply, server, organizationId, userId, request.body);

  const headers: Record<string, string> = { "X-Session-API-Key": server.key };
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const body = method === "GET" || method === "HEAD" ? undefined : (request.body as Buffer | undefined);

  let upstream: Response;
  try {
    upstream = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers,
      body: body && body.length > 0 ? new Uint8Array(body) : undefined,
      redirect: "manual",
    });
  } catch {
    throw new HttpError(502, "The organization's agent sandbox is unreachable");
  }

  reply.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) reply.header(key, value);
  });
  return reply.send(Buffer.from(await upstream.arrayBuffer()));
}

// The browser's request body is never forwarded: only its opening message
// text is used, inside a discussion agent the gateway builds.
async function startDiscussionUpstream(reply: FastifyReply, server: OrgServer, organizationId: string, userId: string, rawBody: unknown) {
  let body: unknown = null;
  try {
    body = rawBody && (rawBody as Buffer).length ? JSON.parse((rawBody as Buffer).toString("utf8")) : null;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  const { conversationId, title, request } = await startDiscussion(organizationId, userId, body);
  let upstream: Response;
  try {
    upstream = await fetch(`${server.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "X-Session-API-Key": server.key, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    await forgetDiscussion(conversationId);
    throw new HttpError(502, "The organization's agent sandbox is unreachable");
  }
  if (!upstream.ok) await forgetDiscussion(conversationId);
  else {
    // Best-effort: an untitled discussion still works.
    await fetch(`${server.baseUrl}/api/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "X-Session-API-Key": server.key, "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => undefined);
  }
  reply.status(upstream.status).header("content-type", upstream.headers.get("content-type") ?? "application/json");
  return reply.send(Buffer.from(await upstream.arrayBuffer()));
}

// --- WebSockets -----------------------------------------------------------

function toUpstreamWsUrl(baseUrl: string, path: string): string {
  const url = new URL(path, `${baseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function closeBoth(a: WebSocket, b: WebSocket, code = 1000, reason = "") {
  for (const ws of [a, b]) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    }
  }
}

function frameText(data: RawData): string | null {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length > MAX_WS_FRAME_BYTES) return null;
  return buf.toString("utf8");
}

interface SocketAuth {
  organizationId: string;
  role: string;
  server: OrgServer;
}

declare module "fastify" {
  interface FastifyRequest {
    agentGatewayAuth?: SocketAuth;
  }
}

/**
 * Pipes a browser socket to the sandbox. `onClientFrame` decides what a
 * client frame becomes upstream: forward it, drop it, or refuse it.
 */
function bridge(
  client: WebSocket,
  upstreamUrl: string,
  key: string,
  onClientFrame: (text: string) => Promise<"forward" | "drop" | { refuse: string }>,
) {
  const upstream = new WebSocket(upstreamUrl, { headers: { "X-Session-API-Key": key } });
  const queued: string[] = [];
  const heartbeat = attachHeartbeat(client);

  upstream.on("open", () => {
    upstream.send(JSON.stringify({ type: "auth", session_api_key: key }));
    for (const frame of queued.splice(0)) upstream.send(frame);
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code) => {
    heartbeat.stop();
    closeBoth(client, upstream, code === 1005 || code === 1006 ? 1011 : code, "agent sandbox closed");
  });
  upstream.on("error", () => closeBoth(client, upstream, 1011, "agent sandbox unreachable"));

  client.on("message", async (data) => {
    const text = frameText(data);
    if (text === null) return closeBoth(client, upstream, 1009, "frame too large");
    const decision = await onClientFrame(text).catch((err: unknown) => ({
      refuse: err instanceof Error ? err.message : "refused",
    }));
    if (decision === "drop") return;
    if (decision !== "forward") {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "error", source: "athernull", message: decision.refuse }));
      }
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else queued.push(text);
  });
  client.on("close", () => {
    heartbeat.stop();
    closeBoth(client, upstream);
  });
  client.on("error", () => closeBoth(client, upstream));
}

function isAuthFrame(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { type?: unknown };
    return parsed?.type === "auth";
  } catch {
    return false;
  }
}

export async function agentGatewayRoutes(app: FastifyInstance) {
  app.decorateRequest("agentGatewayAuth", undefined);

  // Socket upgrades authenticate once here (cookie + Origin + org) and then
  // police every frame.
  const authorizeUpgrade = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!isTrustedOrigin(request.headers.origin)) throw new HttpError(403, "Untrusted origin");
      const { organizationId, role } = await requireOrgSession(request);
      request.agentGatewayAuth = { organizationId, role, server: await loadOrgServer(organizationId) };
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  };

  app.get<{ Params: { id: string } }>(
    `${PREFIX}/sockets/events/:id`,
    { websocket: true, preValidation: authorizeUpgrade },
    (socket, request) => {
      const auth = request.agentGatewayAuth!;
      const conversationId = request.params.id;
      const query = (request.raw.url ?? "").split("?")[1];
      const url = toUpstreamWsUrl(auth.server.baseUrl, `/sockets/events/${encodeURIComponent(conversationId)}${query ? `?${query}` : ""}`);
      bridge(socket, url, auth.server.key, async (text) => {
        if (isAuthFrame(text)) return "drop";
        // Anything else the browser sends on this socket is a chat message
        // to the agent: same gate as POST /api/conversations/:id/events.
        await authorizeConversationWork(conversationId, "/events", auth.organizationId, auth.role);
        return "forward";
      });
    },
  );

  app.get(
    `${PREFIX}/sockets/bash-events`,
    { websocket: true, preValidation: authorizeUpgrade },
    (socket, request) => {
      const auth = request.agentGatewayAuth!;
      const query = (request.raw.url ?? "").split("?")[1];
      const url = toUpstreamWsUrl(auth.server.baseUrl, `/sockets/bash-events${query ? `?${query}` : ""}`);
      bridge(socket, url, auth.server.key, async (text) => {
        if (isAuthFrame(text)) return "drop";
        // Running a terminal command in the org's sandbox is control.
        return hasPrivilegedRole(auth.role) ? "forward" : { refuse: "Only organization owners and admins can use the terminal" };
      });
    },
  );

  // Everything else over HTTP. Encapsulated so the raw-body parser only
  // applies here.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES }, (_req, body, done) => done(null, body));
    scope.route({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      url: `${PREFIX}/*`,
      handler: async (request, reply) => {
        try {
          return await proxyHttp(request, reply);
        } catch (err) {
          if (sendHttpError(reply, err)) return;
          throw err;
        }
      },
    });
  });
}
