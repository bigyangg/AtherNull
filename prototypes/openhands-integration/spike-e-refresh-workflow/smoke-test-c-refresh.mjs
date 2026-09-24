// Spike E smoke test — Spike C side. Loads Spike A's real (non-mock) built
// frontend via Spike C's adapter (same setup as Spike C's own
// smoke-test.mjs), clicks through into the seeded conversation's detail
// view, captures that a fresh, uniquely-labeled followup event is genuinely
// ABSENT, inserts it via seed-followup-event.mjs, then RELOADS the page
// (not a UI refresh button — see README.md's "Spike C refresh mechanism"
// section for why: OpenHands' conversation view has no working in-app
// refresh affordance under a statically-served build — no WebSocket, no
// polling, and `query-client-config.ts` sets no refetchInterval/
// refetchOnWindowFocus of its own; the per-query `refetchOnMount: "always"`
// + `staleTime: 0` found in `use-conversation-history.ts` only fires on
// MOUNT, and a full browser reload is what makes that mount happen again
// from scratch) and asserts the new event now appears.
//
// Same throwaway-script pattern spikes A/B/C/D used (plain Playwright, no
// test runner). Run via `npm run smoke-test-c` (cwd: spike-e-refresh-workflow/)
// or `node smoke-test-c-refresh.mjs` directly. Requires:
//   - apps/api dev server on http://localhost:3001
//   - Spike C's adapter-server on http://127.0.0.1:4100 (loopback-only,
//     CORS-allowlisted for http://localhost:4173)
//   - Spike A's frontend built in real mode (`npm run build:app`, cwd
//     spike-a-standalone-shell/upstream/) and served
//     (`npx sirv build/ --single --port 4173`)
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.SPIKE_E_C_APP_URL ?? "http://localhost:4173";
const ADAPTER_URL = process.env.SPIKE_E_C_ADAPTER_URL ?? "http://localhost:4100";
const SCREENSHOT_DIR =
  process.env.SPIKE_E_SCREENSHOT_DIR ?? path.resolve(__dirname, "screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const seedOutputPath = path.resolve(
  __dirname,
  "..",
  "spike-c-full-shell-adapter",
  "seed",
  "seed-output.json",
);
const seedOutputAtStart = JSON.parse(fs.readFileSync(seedOutputPath, "utf8"));
const DISTINCTIVE_SUBSTRING = seedOutputAtStart.distinctiveObjective.match(/\[([^\]]+)\]/)[1]; // "Spike-C probe 7f2a91"

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) {
  console.error(
    "INTERNAL_API_TOKEN is not set. Run with the same value apps/api/.env's " +
      "dev server was started with, e.g.:\n" +
      "  INTERNAL_API_TOKEN=<value from apps/api/.env> node smoke-test-c-refresh.mjs",
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

// Same "already added this adapter as a backend" localStorage seed Spike
// C's own smoke-test.mjs uses, so this test exercises the same real,
// already-verified onboarding-bypassed state rather than reinventing it.
await page.addInitScript(
  ({ adapterUrl }) => {
    window.localStorage.setItem("openhands-onboarded", "true");
    window.localStorage.setItem("analytics-consent", "false");
    window.localStorage.setItem("openhands-telemetry-consent", "denied");
    window.localStorage.setItem("openhands-telemetry-first-use", "true");
    window.localStorage.setItem(
      "openhands-backends",
      JSON.stringify([
        {
          id: "default-local",
          name: "AtherNull Adapter (Spike C)",
          host: adapterUrl,
          apiKey: "unused-adapter-has-no-browser-auth",
          kind: "local",
        },
      ]),
    );
    window.localStorage.setItem(
      "openhands-active-backend",
      JSON.stringify({ backendId: "default-local", orgId: null }),
    );
  },
  { adapterUrl: ADAPTER_URL },
);

try {
  // 1. Navigate to homepage, dismiss the telemetry-consent modal if shown
  // (same dance Spike C's own smoke test does), click through into the
  // seeded conversation's detail view.
  await page.goto(BASE_URL + "/", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);

  const confirmPrefsBtn = page.getByRole("button", { name: /confirm preferences/i });
  if (await confirmPrefsBtn.isVisible().catch(() => false)) {
    await confirmPrefsBtn.click();
    await page.waitForTimeout(300);
  }

  const conversationItem = page
    .locator(`text=/${DISTINCTIVE_SUBSTRING.replace(/[[\]]/g, "\\$&")}/`)
    .first();
  await conversationItem.click({ timeout: 10000 });
  await page.waitForTimeout(2000);

  const confirmPrefsBtn2 = page.getByRole("button", { name: /confirm preferences/i });
  if (await confirmPrefsBtn2.isVisible().catch(() => false)) {
    await confirmPrefsBtn2.click();
    await page.waitForTimeout(300);
  }

  const finalUrl = page.url();
  const detailMounted = finalUrl !== BASE_URL + "/";
  record("click-through-to-conversation-detail", detailMounted, `finalUrl=${finalUrl}`);
  if (!detailMounted) {
    throw new Error("Could not reach the conversation detail view — aborting refresh test.");
  }

  await page.waitForTimeout(1500);

  const label = `c-${randomUUID().slice(0, 8)}`;
  const previewText = `[Spike-E followup ${label}]`;

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "c-01-before-refresh.png"), fullPage: true });
  const bodyTextBefore = await page.evaluate(() => document.body.innerText || "");
  const absentBefore = !bodyTextBefore.includes(previewText);
  record(
    "new-event-absent-before-reload",
    absentBefore,
    `looked for "${previewText}" before insertion; found=${!absentBefore}`,
  );

  // 2. Insert the new event via the real internal endpoint.
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

  // 3. THE mechanism under test: Spike C's conversation view has no working
  // in-app refresh under a statically-served build (verified — see
  // README.md). The honest equivalent is a full browser reload, which
  // re-runs the SPA's normal initial-mount data-loading path
  // (use-conversation-history.ts's `refetchOnMount: "always"` +
  // `staleTime: 0` fire again because the component genuinely remounts from
  // scratch, not because of any polling/WebSocket/focus-refetch config).
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "c-02-after-reload.png"), fullPage: true });
  const bodyTextAfter = await page.evaluate(() => document.body.innerText || "");
  const presentAfter = bodyTextAfter.includes(DISTINCTIVE_TEXT);
  record(
    "new-event-present-after-reload",
    presentAfter,
    `looked for "${DISTINCTIVE_TEXT}" after reload; found=${presentAfter}`,
  );

  record(
    "still-on-conversation-detail-after-reload",
    page.url() === finalUrl,
    `url before=${finalUrl}, url after=${page.url()}`,
  );

  console.log("\nConsole/page errors captured during run:");
  console.log(consoleErrors.length ? consoleErrors.slice(0, 20).join("\n") : "(none)");
} catch (e) {
  record("unexpected-script-error", false, e.message);
} finally {
  await browser.close();
}

fs.writeFileSync(
  path.join(__dirname, "smoke-test-c-refresh-results.json"),
  JSON.stringify({ results, consoleErrors: consoleErrors.slice(0, 50) }, null, 2),
);

const allPass = results.every((r) => r.pass);
console.log("\n=== SUMMARY (Spike C refresh) ===");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
process.exit(allPass ? 0 : 1);
