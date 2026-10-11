// ADR-0015 agent gateway policy: pure classification of browser requests to
// an org's Agent Server. The funding gate lives in the "agent" class.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyGatewayRequest as c } from "../src/agent-gateway/policy.js";

test("every read is open to org members", () => {
  for (const path of ["/api/conversations", "/api/conversations/abc/events/search", "/api/settings", "/api/git/diff", "/server_info", "/api/vscode/url"]) {
    assert.equal(c("GET", path).kind, "read", path);
  }
});

test("starting a conversation and the raw LLM proxy are never reachable from a browser", () => {
  assert.equal(c("POST", "/api/conversations").kind, "blocked");
  assert.equal(c("POST", "/api/conversations/").kind, "blocked");
  assert.equal(c("POST", "/v1/chat/completions").kind, "blocked");
  assert.equal(c("GET", "/v1/models").kind, "blocked");
  assert.equal(c("POST", "/v1/responses").kind, "blocked");
  assert.equal(c("POST", "/api/sub-agents").kind, "blocked");
  assert.equal(c("POST", "/api/init").kind, "blocked");
});

test("anything that makes the agent work is gated on the conversation's funded build", () => {
  for (const rest of ["events", "run", "ask_agent", "fork", "goal", "goal/resume", "switch_llm", "condense", "events/respond_to_confirmation"]) {
    assert.deepEqual(c("POST", `/api/conversations/conv-1/${rest}`), { kind: "agent", conversationId: "conv-1" }, rest);
  }
});

test("stopping work and configuring the sandbox is control (owner/admin), not agent work", () => {
  for (const rest of ["pause", "interrupt", "goal/stop", "bash/execute_bash_command", "file/upload", "secrets"]) {
    assert.equal(c("POST", `/api/conversations/conv-1/${rest}`).kind, "control", rest);
  }
  assert.equal(c("DELETE", "/api/conversations/conv-1").kind, "control");
  assert.equal(c("PATCH", "/api/conversations/conv-1").kind, "control");
  for (const [m, path] of [
    ["PATCH", "/api/settings"],
    ["POST", "/api/settings/mcp/github"],
    ["PUT", "/api/settings/secrets"],
    ["POST", "/api/skills/install"],
    ["DELETE", "/api/plugins/installed/x"],
    ["POST", "/api/canvas-extensions/install"],
    ["POST", "/api/llm/provider-connections"],
    ["POST", "/api/mcp/oauth/start"],
    ["POST", "/api/bash/execute_bash_command"],
    ["POST", "/api/file/upload"],
  ] as const) {
    assert.equal(c(m, path).kind, "control", `${m} ${path}`);
  }
});

test("unknown mutations fail closed", () => {
  assert.equal(c("POST", "/api/something-new").kind, "blocked");
  assert.equal(c("POST", "/api/conversations/conv-1/brand-new-thing").kind, "blocked");
  assert.equal(c("DELETE", "/api/conversations/search").kind, "blocked");
});

test("query strings and trailing slashes do not change the class", () => {
  assert.equal(c("POST", "/api/conversations/conv-1/run/?x=1").kind, "agent");
  assert.equal(c("POST", "/api/conversations?x=1").kind, "blocked");
});

test("reads that can expose secrets are owner/admin only", () => {
  for (const path of [
    "/api/settings/secrets/GITHUB_TOKEN",
    "/api/llm/provider-connections",
    "/api/file/download?path=/proc/self/environ",
    "/api/file/archive",
    "/api/conversations/conv-1/file/download",
  ]) {
    assert.equal(c("GET", path).kind, "control", path);
  }
  assert.equal(c("GET", "/api/settings/secrets").kind, "read", "listing names only");
});
