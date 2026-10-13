// Which model builds run with (routing.ts deploymentAgentModel): the
// deployment's own model when it has one, so a profile naming a provider the
// worker has no key for can never fail every build.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_NIM_MODEL, deploymentAgentModel } from "../src/routing.js";

test("AGENT_MODEL always wins", () => {
  assert.equal(deploymentAgentModel({ AGENT_MODEL: "openrouter/some/model", ANTHROPIC_API_KEY: "a" }), "openrouter/some/model");
  assert.equal(deploymentAgentModel({ AGENT_MODEL: "  openrouter/x  " }), "openrouter/x");
});

test("an NVIDIA-only deployment builds with its NIM model", () => {
  assert.equal(deploymentAgentModel({ NVIDIA_NIM_API_KEY: "n" }), DEFAULT_NIM_MODEL);
  assert.equal(deploymentAgentModel({ NVIDIA_NIM_API_KEY: "n", SANDBOX_LLM_MODEL: "nvidia_nim/other" }), "nvidia_nim/other");
});

test("with an Anthropic key (or no key at all) the organization's profile decides", () => {
  assert.equal(deploymentAgentModel({ NVIDIA_NIM_API_KEY: "n", ANTHROPIC_API_KEY: "a" }), null);
  assert.equal(deploymentAgentModel({}), null);
  assert.equal(deploymentAgentModel({ AGENT_MODEL: "   " }), null);
});
