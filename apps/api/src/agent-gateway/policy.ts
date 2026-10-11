// Agent gateway access policy (ADR-0015). Pure: classifies one browser
// request to an org's OpenHands Agent Server, before any proxying happens.
//
//   read    — any org member (every GET/HEAD).
//   control — owner/admin: configuring the org's sandbox (settings, MCP,
//             skills, plugins, profiles, secrets, Apps, files, bash) and
//             stopping work (pause/interrupt). None of this spends LLM
//             budget on the platform's behalf.
//   agent   — owner/admin AND the conversation belongs to a funded AtherNull
//             build that is currently RUNNING. This is the funding gate:
//             no agent work happens outside a funded build.
//   blocked — never from a browser: conversations are only ever created by
//             AtherNull itself after funding, and the server's raw LLM
//             proxy would bypass every gate.
//
// Anything not recognized is blocked (fail closed), so a new upstream
// endpoint is unreachable until it is classified here.

export type GatewayAccess =
  | { kind: "read" }
  | { kind: "control" }
  | { kind: "agent"; conversationId: string }
  | { kind: "blocked"; reason: string };

const CONVERSATION = /^\/api\/conversations\/([^/]+)(\/.*)?$/;

// Per-conversation POSTs that make the agent do (LLM) work.
const AGENT_WORK = new Set([
  "/events",
  "/run",
  "/ask_agent",
  "/condense",
  "/fork",
  "/goal",
  "/goal/resume",
  "/switch_llm",
  "/switch_profile",
  "/switch_acp_model",
  "/load_plugin",
  "/navigate",
  "/runtime/reprovision",
  "/events/respond_to_confirmation",
]);

// Per-conversation mutations that never start agent work.
const CONVERSATION_CONTROL = [
  /^\/pause$/,
  /^\/interrupt$/,
  /^\/goal\/stop$/,
  /^\/confirmation_policy$/,
  /^\/security_analyzer$/,
  /^\/secrets$/,
  /^\/bash\/(execute_bash_command|start_bash_command|bash_events)$/,
  /^\/file\/(upload|create_directory)$/,
];

// Server-wide configuration surfaces (any method).
const CONTROL_PREFIXES = [
  "/api/settings",
  "/api/skills",
  "/api/plugins",
  "/api/profiles",
  "/api/agent-profiles",
  "/api/llm/",
  "/api/mcp/",
  "/api/canvas-extensions",
  "/api/workspaces",
  "/api/bash/",
  "/api/file/",
  "/api/auth/workspace-session",
];

// Reads that can expose secret material (secret values, LLM provider
// credentials, arbitrary sandbox files such as the process environment):
// owner/admin only, like configuration.
const SENSITIVE_READS = [
  /^\/api\/settings\/secrets\/[^/]+$/,
  /^\/api\/llm\/(provider-connections|subscription)/,
  /^\/api\/file\/(download|archive)/,
  /^\/api\/conversations\/[^/]+\/file\/(download|archive)/,
];

export function classifyGatewayRequest(method: string, path: string): GatewayAccess {
  const m = method.toUpperCase();
  const p = path.split("?")[0]!.replace(/\/+$/, "") || "/";

  if (p.startsWith("/v1/")) return { kind: "blocked", reason: "The agent server's LLM proxy is not available" };
  if (m === "GET" || m === "HEAD") return SENSITIVE_READS.some((re) => re.test(p)) ? { kind: "control" } : { kind: "read" };

  if (p === "/api/conversations" && m === "POST") {
    return { kind: "blocked", reason: "Agent conversations start from a funded AtherNull build" };
  }

  const conv = CONVERSATION.exec(p);
  if (conv) {
    const [, conversationId, rest = ""] = conv;
    if (conversationId === "search" || conversationId === "count") return { kind: "blocked", reason: "Unsupported" };
    if (rest === "" && (m === "PATCH" || m === "DELETE")) return { kind: "control" };
    if (m === "POST" && AGENT_WORK.has(rest)) return { kind: "agent", conversationId: conversationId! };
    if (CONVERSATION_CONTROL.some((re) => re.test(rest))) return { kind: "control" };
    return { kind: "blocked", reason: "Unsupported conversation operation" };
  }

  if (CONTROL_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, "") || p.startsWith(prefix))) {
    return { kind: "control" };
  }
  // POST /api/hooks only reads the workspace's hook config.
  if (p === "/api/hooks" && m === "POST") return { kind: "read" };
  if (p === "/api/sub-agents" || p === "/api/init") {
    return { kind: "blocked", reason: "Not available through AtherNull" };
  }
  return { kind: "blocked", reason: "Unsupported agent server operation" };
}
