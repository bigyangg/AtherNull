// Browser smoke check for a verified web app (services/verifier, run inside
// the verifier's throwaway container, network off). Opens the page in
// headless Chromium over the DevTools protocol (Node's built-in WebSocket and
// fetch; no packages) and reports:
//   - errors:      uncaught exceptions, console.error calls, and failed loads
//                  of the page's own files (a script that never runs, a 404)
//   - buttons:     how many clickable controls the page has
//   - interactive: whether clicking them changes what the page shows
// Prints one JSON line; the verifier decides PASS/FAIL from it.
//
//   node browser_smoke.mjs http://127.0.0.1:8123/

import { spawn } from "node:child_process";

const url = process.argv[2];
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  "chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/athernull-smoke-profile",
    "about:blank",
  ],
  { stdio: "ignore" },
);

function finish(result, code = 0) {
  console.log(JSON.stringify(result));
  try {
    chrome.kill("SIGKILL");
  } catch {
    // already gone
  }
  process.exit(code);
}

setTimeout(() => finish({ errors: ["the browser check timed out"], buttons: 0, interactive: null }, 0), 75_000).unref();

async function pageSocketUrl() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error("Chromium did not start");
}

// Noise that says nothing about the app itself.
const IGNORED = [/favicon\.ico/i];

try {
  const ws = new WebSocket(await pageSocketUrl());
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 0;
  const pending = new Map();
  const errors = [];
  const record = (text) => {
    const line = String(text ?? "").split("\n")[0].replace(/^Uncaught /, "").slice(0, 300);
    if (line && !IGNORED.some((re) => re.test(line)) && !errors.includes(line)) errors.push(line);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      record(d.exception?.description ?? d.text);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      record(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      record(`${msg.params.entry.text}${msg.params.entry.url ? ` (${msg.params.entry.url})` : ""}`);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  // Also collected from inside the page, before any of its own scripts run:
  // DevTools exception events can race the page load, these cannot.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__athernullErrors = [];
      addEventListener("error", (e) => { __athernullErrors.push(e.message || (e.target && e.target.src ? "failed to load " + e.target.src : String(e))); }, true);
      addEventListener("unhandledrejection", (e) => { __athernullErrors.push("Unhandled rejection: " + (e.reason && e.reason.message || e.reason)); });`,
  });
  await send("Page.navigate", { url });
  await sleep(2500);
  for (const message of (await evaluate("window.__athernullErrors || []")) ?? []) record(message);

  const buttons =
    (await evaluate(`document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]').length`)) ?? 0;

  let interactive = null;
  if (buttons > 0 && errors.length === 0) {
    // Click controls one at a time (at most 12) and see whether anything on
    // the page changes: a UI whose buttons do nothing is not a working app.
    interactive = await evaluate(`(async () => {
      const snapshot = () => document.body ? document.body.innerText + '|' + document.body.innerHTML.length : '';
      const before = snapshot();
      const controls = [...document.querySelectorAll('button, [role="button"], input[type="button"]')].slice(0, 12);
      for (const el of controls) {
        try { el.click(); } catch {}
        await new Promise((r) => setTimeout(r, 60));
        if (snapshot() !== before) return true;
      }
      return false;
    })()`);
  }

  finish({ errors, buttons, interactive });
} catch (err) {
  finish({ errors: [`the browser check could not run: ${err?.message ?? err}`], buttons: 0, interactive: null });
}
