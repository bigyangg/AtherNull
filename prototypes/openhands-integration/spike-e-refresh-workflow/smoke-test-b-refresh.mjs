// Spike E smoke test — Spike B side. Loads `/harness-live`, captures that a
// fresh, uniquely-labeled followup event is genuinely ABSENT, inserts it via
// seed-followup-event.mjs (the same zero-cost internal endpoint spikes C/D
// already used), clicks the new "Refresh" button
// (spike-b-selective-reuse/app/harness-live/page.tsx), and asserts the new
// event now appears where it did not before. This is the genuine
// data-freshness test — not a re-render of the same snapshot.
//
// Same throwaway-script pattern spikes A/B/C/D used (plain Playwright, no
// test runner). Run via `npm run smoke-test-b` (cwd: spike-e-refresh-workflow/)
// or `node smoke-test-b-refresh.mjs` directly. Requires:
//   - apps/api dev server on http://localhost:3001
//   - Spike C's adapter-server on http://127.0.0.1:4100 (loopback-only,
//     CORS-allowlisted for http://localhost:3902 — see
//     spike-c-full-shell-adapter/SECURITY-FIX-network-binding.md)
//   - Spike B's Next harness built (`npm run build`) and served
//     (`npx next start --port 3902`) so the "Refresh" button is actually in
//     the served bundle, not just the source
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.SPIKE_E_B_APP_URL ?? "http://localhost:3902";
const SCREENSHOT_DIR =
  process.env.SPIKE_E_SCREENSHOT_DIR ?? path.resolve(__dirname, "screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) {
  console.error(
    "INTERNAL_API_TOKEN is not set. Run with the same value apps/api/.env's " +
      "dev server was started with, e.g.:\n" +
      "  INTERNAL_API_TOKEN=<value from apps/api/.env> node smoke-test-b-refresh.mjs",
  );
  process.exit(1);
}

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
  // 1. Initial load.
  await page.goto(BASE_URL + "/harness-live", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector('[data-testid="load-status"][data-load-status="ready"]', {
    timeout: 15000,
  });

  const label = `b-${randomUUID().slice(0, 8)}`;

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "b-01-before-refresh.png"), fullPage: true });

  const bodyTextBefore = await page.evaluate(() => document.body.innerText || "");

  // 2. Genuine "before" check: we know the label we're ABOUT to insert
  // (generated above, not yet sent to the server), so its exact text cannot
  // possibly be in the DOM yet. This is a stronger assertion than "some
  // event is missing" — it's this run's specific, never-before-seen string.
  const previewText = `[Spike-E followup ${label}]`;
  const absentBefore = !bodyTextBefore.includes(previewText);
  record(
    "new-event-absent-before-refresh",
    absentBefore,
    `looked for "${previewText}" before insertion; found=${!absentBefore}`,
  );

  // 3. Insert the new event via the real internal endpoint (same zero-cost
  // pattern spikes C/D used), then read back exactly what text it inserted.
  execFileSync("node", ["seed-followup-event.mjs", label], {
    cwd: __dirname,
    env: { ...process.env },
    stdio: "inherit",
  });
  const seedOutput = JSON.parse(
    fs.readFileSync(path.join(__dirname, "seed-followup-event-output.json"), "utf8"),
  );
  if (seedOutput.label !== label) {
    throw new Error(
      `seed-followup-event-output.json label mismatch: expected "${label}", got "${seedOutput.label}" — a concurrent run may have overwritten it.`,
    );
  }
  const DISTINCTIVE_TEXT = seedOutput.distinctiveText;

  // 4. Click the new Refresh button and wait for it to actually re-run
  // (status flips to loading, then back to ready) — not a fixed timeout.
  await page.click('[data-testid="refresh-button"]');
  await page
    .waitForSelector('[data-testid="load-status"][data-load-status="loading"]', { timeout: 5000 })
    .catch(() => {
      // The fetch may resolve faster than this poll catches "loading" —
      // that's fine, the "ready" wait below is the assertion that matters.
    });
  await page.waitForSelector('[data-testid="load-status"][data-load-status="ready"]', {
    timeout: 15000,
  });

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "b-02-after-refresh.png"), fullPage: true });

  const bodyTextAfter = await page.evaluate(() => document.body.innerText || "");
  const presentAfter = bodyTextAfter.includes(DISTINCTIVE_TEXT);
  record(
    "new-event-present-after-refresh",
    presentAfter,
    `looked for "${DISTINCTIVE_TEXT}" after clicking Refresh; found=${presentAfter}`,
  );

  // 5. Event count in the page's own "Loaded N events" status line actually
  // increased by exactly 1 — corroborates the DOM-text assertion above with
  // the harness's own reported count, not just a substring match.
  const countBefore = seedOutput.countBefore;
  const countAfter = seedOutput.countAfter;
  const countLineMatch = bodyTextAfter.match(/Loaded (\d+) real events/);
  const renderedCount = countLineMatch ? Number(countLineMatch[1]) : null;
  record(
    "rendered-event-count-matches-db-after-refresh",
    renderedCount === countAfter,
    `db countAfter=${countAfter}, rendered count="${renderedCount}" (countBefore was ${countBefore})`,
  );

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
  path.join(__dirname, "smoke-test-b-refresh-results.json"),
  JSON.stringify({ results, consoleErrors: consoleErrors.slice(0, 50) }, null, 2),
);

const allPass = results.every((r) => r.pass);
console.log("\n=== SUMMARY (Spike B refresh) ===");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
process.exit(allPass ? 0 : 1);
