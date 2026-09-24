// Spike F smoke test — Spike B side. Drives the new `/harness-journey` route
// (spike-b-selective-reuse/app/harness-journey/page.tsx) against Spike C's
// adapter-server (Phase 1 mapping changes) and the real seeded multi-attempt
// journey recorded in seed-journey-output.json. Does NOT touch
// `/harness-live` or its own smoke test (smoke-test.mjs) — those are frozen,
// already-verified Spike D/E artifacts.
//
// Asserts the canonical checklist from README.md's "Methodology" section,
// item by item (numbers below match that list exactly — read it first if a
// check here looks unexplained):
//   1. Attempt-switching (via the new custom attempt-selector)
//   2. Real, distinct file-editor diff for the seeded str_replace event
//   3. Real status/verification badge, distinct per attempt
//   4. Terminal events render (chat feed AND the dedicated replay panel)
//   5. "Return to review" link href correctness (DOM inspection only)
//   6. Zero new console errors
//
// Same throwaway-script pattern spikes A-E used (plain Playwright, no test
// runner). Requires: apps/api on :3001, the adapter-server on 127.0.0.1:4100,
// and spike-b-selective-reuse built + served on port 3902 (the adapter's
// existing CORS-allowlisted origin for Spike B — see
// spike-c-full-shell-adapter/adapter-server/src/index.ts):
//   cd spike-b-selective-reuse && npm run build && npx next start -p 3902
// Run via `node smoke-test-b-journey.mjs` (cwd: this directory).
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.SPIKE_F_B_APP_URL ?? "http://localhost:3902";
const SCREENSHOT_DIR =
  process.env.SPIKE_F_SCREENSHOT_DIR ?? path.resolve(__dirname, "screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const seedOutput = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "seed-journey-output.json"), "utf8"),
);
const EXPECTED_REVIEW_URL = `http://localhost:3000/projects/${seedOutput.projectId}/tasks/${seedOutput.taskId}`;
const ATTEMPT1 = seedOutput.attempts[0];
const ATTEMPT2 = seedOutput.attempts[1];

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || null });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`);
}

// Known, already-documented noise (see README.md item 6) — not a failure.
const KNOWN_NOISE = [/WebSocket/i, /CORS policy/i, /ERR_FAILED/i, /net::ERR_/i];
function isKnownNoise(text) {
  return KNOWN_NOISE.some((re) => re.test(text));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));

try {
  await page.goto(`${BASE_URL}/harness-journey`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "b-01-loaded.png"), fullPage: true });

  // --- Checklist item 1: attempt-switching -------------------------------
  const attemptTabs = page.locator('[data-testid="attempt-tab"]');
  const tabCount = await attemptTabs.count();
  record("1-attempt-selector-shows-2-attempts", tabCount === 2, `found ${tabCount} tab(s)`);

  const tabTexts = await attemptTabs.allTextContents();
  const hasAttempt1Title = tabTexts.some((t) => t.includes("attempt 1 of 2"));
  const hasAttempt2Title = tabTexts.some((t) => t.includes("attempt 2 of 2"));
  record(
    "1-attempt-titles-carry-attempt-distinguisher",
    hasAttempt1Title && hasAttempt2Title,
    `tabTexts=${JSON.stringify(tabTexts)}`,
  );

  // Select attempt 1 (failed) first — distinct, smaller event set.
  await page.locator('[data-testid="attempt-tab"]', { hasText: "attempt 1 of 2" }).click();
  await page.waitForTimeout(1200);
  const attempt1LoadStatus = await page
    .locator('[data-testid="load-status"]')
    .textContent()
    .catch(() => "");
  const attempt1EventCountMatch = attempt1LoadStatus?.match(/Loaded (\d+) real events/);
  const attempt1EventCount = attempt1EventCountMatch ? Number(attempt1EventCountMatch[1]) : null;
  record(
    "1-attempt-1-shows-its-own-event-count",
    attempt1EventCount === ATTEMPT1.eventCount,
    `expected ${ATTEMPT1.eventCount}, got ${attempt1EventCount} (status text: "${attempt1LoadStatus}")`,
  );

  // --- Checklist item 3 (attempt 1 half): distinct, non-PASS status -----
  const attempt1Badge = await page.locator('[data-testid="status-badge"]').textContent();
  const attempt1BadgeOk = attempt1Badge.includes("SETTLED") && !attempt1Badge.includes("PASS");
  record(
    "3-attempt-1-status-badge-settled-no-pass",
    attempt1BadgeOk,
    `badge text: "${attempt1Badge}"`,
  );

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "b-02-attempt1.png"), fullPage: true });

  // Switch to attempt 2 (SETTLED+PASS) — the fuller fixture.
  await page.locator('[data-testid="attempt-tab"]', { hasText: "attempt 2 of 2" }).click();
  await page.waitForTimeout(1500);
  const attempt2LoadStatus = await page.locator('[data-testid="load-status"]').textContent();
  const attempt2EventCountMatch = attempt2LoadStatus?.match(/Loaded (\d+) real events/);
  const attempt2EventCount = attempt2EventCountMatch ? Number(attempt2EventCountMatch[1]) : null;
  record(
    "1-attempt-2-shows-its-own-distinct-event-count",
    attempt2EventCount === ATTEMPT2.eventCount && attempt2EventCount !== attempt1EventCount,
    `expected ${ATTEMPT2.eventCount} (and distinct from attempt 1's ${attempt1EventCount}), got ${attempt2EventCount}`,
  );

  // --- Checklist item 3 (attempt 2 half): SETTLED + PASS -----------------
  const attempt2Badge = await page.locator('[data-testid="status-badge"]').textContent();
  const attempt2BadgeOk = attempt2Badge.includes("SETTLED") && attempt2Badge.includes("PASS");
  record(
    "3-attempt-2-status-badge-settled-and-pass",
    attempt2BadgeOk,
    `badge text: "${attempt2Badge}"`,
  );

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "b-03-attempt2.png"), fullPage: true });

  // --- Checklist item 2: real, distinct file-editor diff -----------------
  // Expand the collapsed action group, then every individual event's own
  // chevron, so the str_replace event's DiffView body actually mounts (it's
  // lazily rendered behind 2 layers of collapse, same as Spike C's real UI).
  const groupToggle = page.locator('[data-testid="event-group-toggle"]').first();
  if ((await groupToggle.count()) > 0) {
    await groupToggle.click();
    await page.waitForTimeout(600);
  }
  const expandHandles = await page.getByRole("button", { name: /expand/i }).elementHandles();
  for (const handle of expandHandles) {
    try {
      await handle.click();
      await page.waitForTimeout(250);
    } catch {
      /* a handle can go stale if its row re-renders; best-effort */
    }
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "b-04-expanded.png"), fullPage: true });

  const diffMarkerCount = await page
    .locator('[class*="bg-status-success-bg"], [class*="bg-status-fail-bg"]')
    .count();
  record(
    "2-real-diff-view-renders-not-markdown-fallback",
    diffMarkerCount > 0,
    `found ${diffMarkerCount} diff-row element(s) with the vendored DiffView's own row-coloring classes`,
  );

  const fileChipCount = await page.locator('[data-testid="file-path-chip"]').count();
  record(
    "2-file-path-chip-renders-alongside-diff",
    fileChipCount >= 2,
    `expected >=2 (create + str_replace events), found ${fileChipCount}`,
  );

  // --- Checklist item 4: terminal events -------------------------------
  const bodyTextAfterExpand = await page.evaluate(() => document.body.innerText || "");
  const chatFeedHasCommand = bodyTextAfterExpand.includes("npm run test -- metrics.test.ts");
  const chatFeedHasOutput = bodyTextAfterExpand.includes("GET /metrics returns a request count");
  record(
    "4-terminal-command-and-output-visible-in-chat-feed",
    chatFeedHasCommand && chatFeedHasOutput,
    `command found=${chatFeedHasCommand}, output found=${chatFeedHasOutput}`,
  );

  const xtermElementCount = await page.locator('[class*="xterm"]').count();
  const terminalPanelText = await page.evaluate(() => {
    const el = document.querySelector('[class*="xterm-screen"]') ?? document.querySelector('[class*="xterm"]');
    return el ? (el.closest("div")?.parentElement?.innerText ?? "") : "";
  });
  record(
    "4-terminal-replay-panel-shows-real-content",
    xtermElementCount > 0 &&
      (terminalPanelText.includes("metrics.test.ts") || bodyTextAfterExpand.includes("$ npm run test")),
    `xterm element count=${xtermElementCount}`,
  );

  // --- Checklist item 5: return-to-review link ---------------------------
  const reviewHref = await page.locator('[data-testid="return-to-review-link"]').getAttribute("href");
  record(
    "5-return-to-review-href-matches-real-route-pattern",
    reviewHref === EXPECTED_REVIEW_URL,
    `expected "${EXPECTED_REVIEW_URL}", got "${reviewHref}"`,
  );

  // --- Checklist item 6: console errors ----------------------------------
  const unexpectedErrors = consoleErrors.filter((e) => !isKnownNoise(e));
  record(
    "6-zero-unexpected-console-errors",
    unexpectedErrors.length === 0,
    unexpectedErrors.length > 0
      ? JSON.stringify(unexpectedErrors.slice(0, 10))
      : `${consoleErrors.length} known-noise message(s) ignored`,
  );
} catch (e) {
  record("unexpected-script-error", false, e.message);
} finally {
  await browser.close();
}

fs.writeFileSync(
  path.join(__dirname, "smoke-test-b-journey-results.json"),
  JSON.stringify({ results, consoleErrors: consoleErrors.slice(0, 50) }, null, 2),
);

const allPass = results.every((r) => r.pass);
console.log("\n=== SUMMARY (Spike B journey) ===");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
process.exit(allPass ? 0 : 1);
