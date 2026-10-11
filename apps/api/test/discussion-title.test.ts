// Discussions are titled by the gateway from the user's opening message,
// not by the sandbox model.
import assert from "node:assert/strict";
import { test } from "node:test";

import { discussionTitle } from "../src/agent-gateway/discussions.js";

test("a discussion is titled by the first line of its opening message", () => {
  assert.equal(discussionTitle("Add GET /version\nwith a test, please"), "Add GET /version");
  assert.equal(discussionTitle("\n\n   spaced    out   words  \nmore"), "spaced out words");
});

test("long first lines are shortened, empty ones get a default", () => {
  const title = discussionTitle("x".repeat(200));
  assert.equal(title.length, 60);
  assert.ok(title.endsWith("…"));
  assert.equal(discussionTitle("   \n "), "New discussion");
});
