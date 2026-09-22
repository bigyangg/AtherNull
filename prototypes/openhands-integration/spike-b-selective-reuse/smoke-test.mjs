// SPIKE D Playwright smoke test for `/harness-live` — the new route that
// renders Spike B's vendored `<Messages>`/`<Terminal>` components against
// REAL AtherNull API data read from a seeded LOCAL DEVELOPMENT DATABASE via
// Spike C's already-working adapter-server (unmodified). This is NOT the
// output of a paid coding-agent execution — the seed data was created
// through the same zero-cost, zero-LLM, zero-Solana internal test-only
// endpoints `apps/api/test/job-lifecycle.test.ts` uses (see
// spike-c-full-shell-adapter/seed/seed.ts and README.md).
//
// Same throwaway-script pattern Spikes A/C used (plain Playwright, no test
// runner), run directly under this spike's own isolated npm project — Spike
// C had to borrow Spike A's `upstream/` Playwright install (copying its
// smoke test in as a gitignored, never-committed file) because it had no
// install of its own; this spike instead added `@playwright/test` as its
// own devDependency (pinned to the same 1.62.1 already cached on this
// machine, so no Chromium re-download was needed), keeping this script
// self-contained under spike-b-selective-reuse/ with no cross-spike copy
// step. Run via `npm run smoke-test-live` (cwd:
// spike-b-selective-reuse/) or `node smoke-test.mjs` directly.
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const BASE_URL = process.env.SPIKE_D_APP_URL ?? "http://localhost:3902";
const SCREENSHOT_DIR =
  process.env.SPIKE_D_SCREENSHOT_DIR ?? path.resolve("screenshots-live");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Ground truth, from spike-c-full-shell-adapter/seed/seed-output.json —
// read directly, not hardcoded blind, so this test fails loudly if the
// seeded dataset ever changes.
const seedOutputPath = path.resolve(
  "..",
  "spike-c-full-shell-adapter",
  "seed",
  "seed-output.json",
);
const seedOutput = JSON.parse(fs.readFileSync(seedOutputPath, "utf8"));
const DISTINCTIVE_TITLE = seedOutput.distinctiveObjective;
const DISTINCTIVE_EVENT_MESSAGE =
  "I'll add a GET /health route with a per-IP rate limit and a passing test.";
const TERMINAL_COMMAND = "npm run test -- health.test.ts";
const TERMINAL_OUTPUT_SUBSTRING = "PASS health.test.ts";

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || null });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => {
  consoleErrors.push("pageerror: " + err.message);
});

try {
  await page.goto(BASE_URL + "/harness-live", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "01-initial-load.png"),
    fullPage: true,
  });

  // 1. Loading must actually complete (no stuck spinner/loading state)
  // before any content assertion runs — wait for the explicit
  // data-load-status="ready" marker harness-live/page.tsx sets once its
  // fetch resolves, not just a fixed timeout.
  let loadCompleted = false;
  try {
    await page.waitForSelector('[data-testid="load-status"][data-load-status="ready"]', {
      timeout: 15000,
    });
    loadCompleted = true;
  } catch {
    /* recorded as a failure below */
  }
  const loadStatusEl = page.locator('[data-testid="load-status"]');
  const loadStatusText = (await loadStatusEl.textContent().catch(() => null)) ?? "(not found)";
  record(
    "loading-completed-before-assertions",
    loadCompleted,
    `data-load-status text: "${loadStatusText}"`,
  );

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "02-loaded.png"),
    fullPage: true,
  });

  const bodyText = await page.evaluate(() => document.body.innerText || "");

  // 2. Exact seeded conversation title / distinctive objective string.
  const titleVisible = bodyText.includes(DISTINCTIVE_TITLE);
  record(
    "exact-seeded-conversation-title-present",
    titleVisible,
    `looked for "${DISTINCTIVE_TITLE}"; found=${titleVisible}`,
  );

  // 3. A distinctive seeded event message's exact text (the agent's 2nd
  // MessageEvent — deliberately not the title text, which the conversation
  // list endpoint alone could already satisfy).
  const eventMessageVisible = bodyText.includes(DISTINCTIVE_EVENT_MESSAGE);
  record(
    "distinctive-seeded-event-message-present",
    eventMessageVisible,
    `looked for "${DISTINCTIVE_EVENT_MESSAGE}"; found=${eventMessageVisible}`,
  );

  // 4. Seeded terminal command AND its output text — read directly from the
  // xterm.js DOM renderer's rendered rows (no addon-canvas/addon-webgl is
  // loaded in use-terminal.ts, so @xterm/xterm's default DOM renderer puts
  // real text nodes in `.xterm-rows`, not just canvas pixels).
  const terminalText = await page
    .locator(".xterm-rows")
    .innerText()
    .catch(() => "");
  const commandVisible = terminalText.includes(TERMINAL_COMMAND);
  const outputVisible = terminalText.includes(TERMINAL_OUTPUT_SUBSTRING);
  record(
    "terminal-shows-seeded-command",
    commandVisible,
    `looked for "${TERMINAL_COMMAND}" in .xterm-rows; found=${commandVisible}`,
  );
  record(
    "terminal-shows-seeded-output",
    outputVisible,
    `looked for "${TERMINAL_OUTPUT_SUBSTRING}" in .xterm-rows; found=${outputVisible}`,
  );

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "03-event-feed-and-terminal.png"),
    fullPage: true,
  });

  // 5. Zero browser console errors.
  record(
    "zero-console-errors",
    consoleErrors.length === 0,
    consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 10)) : "(none)",
  );

  console.log("\nConsole/page errors captured during run:");
  console.log(consoleErrors.length ? consoleErrors.slice(0, 20).join("\n") : "(none)");
} catch (e) {
  record("unexpected-script-error", false, e.message);
} finally {
  await browser.close();
}

fs.writeFileSync(
  path.join(SCREENSHOT_DIR, "..", "smoke-test-live-results.json"),
  JSON.stringify({ results, consoleErrors: consoleErrors.slice(0, 50) }, null, 2),
);

const allPass = results.every((r) => r.pass);
console.log("\n=== SUMMARY ===");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
process.exit(allPass ? 0 : 1);
