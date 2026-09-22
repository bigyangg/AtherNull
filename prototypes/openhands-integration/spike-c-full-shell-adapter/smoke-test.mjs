// Spike C Playwright smoke test. Same approach as Spike A's own
// upstream/smoke-test.mjs (throwaway, plain Playwright, no test runner) but
// asserting REAL, distinctive AtherNull data flows through the adapter
// end-to-end - not OpenHands' own mock fixtures. Requires Playwright +
// Chromium already installed (reused from Spike A's
// spike-a-standalone-shell/upstream/node_modules), so this script is copied
// into that upstream/ checkout and run from there (see ../README.md
// "Reproduce" section) - upstream/ is gitignored, so the copy never gets
// committed; this file under spike-c-full-shell-adapter/ is the source of
// truth.
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const BASE_URL = process.env.SPIKE_C_APP_URL ?? "http://localhost:4173";
const ADAPTER_URL = process.env.SPIKE_C_ADAPTER_URL ?? "http://localhost:4100";
const DISTINCTIVE_SUBSTRING = process.env.SPIKE_C_DISTINCTIVE ?? "Spike-C probe 7f2a91";
const SCREENSHOT_DIR = process.env.SPIKE_C_SCREENSHOT_DIR ?? path.resolve("..", "spike-c-full-shell-adapter", "screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || null });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " - " + detail : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
const webSocketAttempts = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => {
  consoleErrors.push("pageerror: " + err.message);
});
page.on("websocket", (ws) => {
  webSocketAttempts.push({ url: ws.url(), status: "opened" });
  ws.on("socketerror", (err) => webSocketAttempts.push({ url: ws.url(), status: "error", detail: err }));
  ws.on("close", () => webSocketAttempts.push({ url: ws.url(), status: "closed" }));
});

// Seed localStorage with a "local" backend pointing at the SPIKE C ADAPTER
// (a genuinely different origin from BASE_URL, exercising the adapter's CORS
// path for real - not window.location.origin the way Spike A's same-origin
// mock-mode smoke test did). Same keys/shape as
// spike-a-standalone-shell/upstream/tests/e2e/support/onboarding-helpers.ts's
// showOnboarding() helper and Spike A's own smoke-test.mjs use to bypass the
// "Add a backend" first-run wizard - this is a faithful "user already added
// their adapter as a backend" state, not a way of dodging real app behavior.
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
          // The adapter performs no browser-side auth check at all (it holds
          // AtherNull's real session cookie server-side only, per
          // adapter-server/src/athernull-client.ts) - this value is never
          // read by the adapter, only carried by OpenHands' own backend-
          // registry shape, which requires *some* string here.
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
  // 1. Navigate to homepage, assert it renders (not blank / not an error boundary).
  await page.goto(BASE_URL + "/", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);

  const confirmPrefsBtn = page.getByRole("button", { name: /confirm preferences/i });
  if (await confirmPrefsBtn.isVisible().catch(() => false)) {
    await confirmPrefsBtn.click();
    await page.waitForTimeout(300);
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01-homepage.png"), fullPage: true });

  const bodyText = await page.evaluate(() => document.body.innerText || "");
  const rootHtml = await page.evaluate(() => {
    const root = document.getElementById("root") || document.body;
    return root ? root.innerHTML.length : 0;
  });
  const hasErrorBoundaryText = /application error|something went wrong|unexpected error|stack trace at/i.test(bodyText);
  const nonBlank = rootHtml > 500 && bodyText.trim().length > 0;
  record(
    "homepage-renders-real-content",
    nonBlank && !hasErrorBoundaryText,
    `rootInnerHTMLLength=${rootHtml}, bodyTextLength=${bodyText.trim().length}, errorBoundaryDetected=${hasErrorBoundaryText}`,
  );

  // 2. THE core assertion of this spike: the sidebar/homepage shows the
  // real, distinctive AtherNull-seeded task title - proof this is real
  // AtherNull data flowing through the adapter, not OpenHands' own mock
  // fixtures (which would never contain this string).
  const distinctiveVisible = bodyText.includes(DISTINCTIVE_SUBSTRING);
  record(
    "homepage-shows-real-athernull-task-title",
    distinctiveVisible,
    `looked for substring "${DISTINCTIVE_SUBSTRING}" in page text; found=${distinctiveVisible}`,
  );

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-sidebar.png"), fullPage: true });

  // 3. Click through (not a direct URL nav) into the conversation detail view.
  let clickedInto = false;
  let finalUrl = null;
  let detailMounted = false;

  // The telemetry-consent dialog can appear on a delay (after the initial
  // dismiss-attempt above), and it overlays the sidebar - dismiss it again
  // right before the click-through step if it's showing.
  const confirmPrefsBtn2 = page.getByRole("button", { name: /confirm preferences/i });
  if (await confirmPrefsBtn2.isVisible().catch(() => false)) {
    await confirmPrefsBtn2.click();
    await page.waitForTimeout(300);
  }

  const conversationItem = page.locator(`text=/${DISTINCTIVE_SUBSTRING.replace(/[[\]]/g, "\\$&")}/`).first();
  if ((await conversationItem.count()) > 0 && (await conversationItem.isVisible().catch(() => false))) {
    try {
      await conversationItem.click({ timeout: 5000 });
      clickedInto = true;
    } catch {
      /* fall through to failure recording below */
    }
  }

  if (clickedInto) {
    await page.waitForTimeout(2000);
    finalUrl = page.url();
    const bodyText2 = await page.evaluate(() => document.body.innerText || "");
    const rootHtml2 = await page.evaluate(() => {
      const root = document.getElementById("root") || document.body;
      return root ? root.innerHTML.length : 0;
    });
    detailMounted = finalUrl !== BASE_URL + "/" && rootHtml2 > 500;
    record(
      "click-through-to-conversation-detail",
      detailMounted,
      `finalUrl=${finalUrl}, rootInnerHTMLLength=${rootHtml2}`,
    );

    // 4. The detail view must show the real seeded EVENT content (not just
    // the title, which the search/list endpoint alone could already prove) -
    // this proves GET /api/conversations/:id/events/search round-tripped
    // real AtherNull execution_events through the adapter's mapping.ts.
    await page.waitForTimeout(1500);
    const detailBodyText = await page.evaluate(() => document.body.innerText || "");
    // Deliberately NOT "rate-limited GET /health endpoint" - that phrase is
    // also part of the task title (already proven visible by the previous
    // assertion), so it would pass even if the events themselves never
    // rendered. These two are text that only exists inside the seeded
    // MessageEvent/ActionEvent content itself:
    //  - the agent's second MessageEvent (distinct from the title)
    //  - "N actions completed" is OpenHands' own collapsed-group summary,
    //    rendered from the count of ActionEvent/ObservationEvent pairs the
    //    adapter mapped (3: the terminal pair + 2 file-editor pairs) - the
    //    individual command/stdout text inside that group is not in the DOM
    //    until it's expanded by click, so the group's own visible summary
    //    is used as the assertion instead of forcing an extra interaction.
    const eventSubstrings = [
      "I'll add a GET /health route with a per-IP rate limit and a passing test", // 2nd MessageEvent
      "actions completed", // ActionEvent/ObservationEvent collapsed-group summary
    ];
    const foundEventStrings = eventSubstrings.filter((s) => detailBodyText.includes(s));
    record(
      "conversation-detail-shows-real-seeded-events",
      foundEventStrings.length > 0,
      `looked for ${JSON.stringify(eventSubstrings)}; found=${JSON.stringify(foundEventStrings)}`,
    );

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-detail-view.png"), fullPage: true });
  } else {
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-detail-view.png"), fullPage: true });
    record(
      "click-through-to-conversation-detail",
      false,
      `Could not find/click a visible element containing "${DISTINCTIVE_SUBSTRING}"`,
    );
    record("conversation-detail-shows-real-seeded-events", false, "skipped - click-through failed");
  }

  // 5. WebSocket/realtime status - recorded honestly, not faked or hidden.
  // Expected (per Spike A's own documented finding): a static-file-served
  // build has no WebSocket backend to connect to, so this should show
  // failed/errored attempts, not a working live connection. The adapter
  // implements no WebSocket endpoint at all (out of scope per the plan).
  record(
    "websocket-status-recorded",
    true,
    webSocketAttempts.length > 0
      ? `${webSocketAttempts.length} attempt(s): ${JSON.stringify(webSocketAttempts)}`
      : "no WebSocket connection attempts observed during this run",
  );

  console.log("\nConsole/page errors captured during run:");
  console.log(consoleErrors.length ? consoleErrors.slice(0, 20).join("\n") : "(none)");
} catch (e) {
  record("unexpected-script-error", false, e.message);
} finally {
  await browser.close();
}

fs.writeFileSync(
  path.join(SCREENSHOT_DIR, "..", "smoke-test-results.json"),
  JSON.stringify({ results, consoleErrors: consoleErrors.slice(0, 50), webSocketAttempts }, null, 2),
);

const allPass = results.every((r) => r.pass);
console.log("\n=== SUMMARY ===");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
process.exit(allPass ? 0 : 1);
