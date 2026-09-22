# Adapter-server network exposure: fix and verification

Addendum to this spike, written after Spike D's verification found
`adapter-server` (port 4100) bound to all network interfaces
(`0.0.0.0`/`[::]`, not loopback-only as originally assumed) combined with
fully permissive CORS (`cors({ origin: true })`). See
`spike-b-selective-reuse/README.md`'s "Adapter-server security properties"
section for Spike D's original finding writeup — this file records the fix
and its verification, it does not restate the finding narrative.

## What changed

`adapter-server/src/index.ts`, two changes only:

1. `app.listen(PORT, ...)` -> `app.listen(PORT, "127.0.0.1", ...)` — explicit
   loopback-only bind. This is the actual network-containment fix.
2. `cors({ origin: true })` -> `cors({ origin: ["http://localhost:4173", "http://localhost:3902"] })`
   — explicit allowlist of the two real, verified callers:
   - `http://localhost:4173`: Spike A's built frontend, as served by this
     spike's own README ("How to reproduce" step 3: `npx sirv build/
     --single --port 4173`).
   - `http://localhost:3902`: Spike B/D's Next harness, as served per
     `spike-b-selective-reuse/README.md`'s Spike D section
     (`npm start -- --port 3902`).

**CORS is not a network-access control.** It is a browser-enforced
same-origin restriction: a non-browser client (`curl`, a script, another
service) can still set any `Origin` header it likes and get a response. The
allowlist only prevents an arbitrary *web page* running in a *browser* from
reading this adapter's responses cross-origin. The `127.0.0.1` bind is what
actually stops a non-browser client on another machine from reaching this
server at all — that's the real containment.

## Verification (2026-09-22, re-run same day as the fix)

Pre-existing adapter process (bound to `0.0.0.0:4100`/`[::]:4100`, PID
32120, confirmed via `netstat -ano | findstr :4100`) was stopped
(`taskkill /PID 32120 /F`) before editing.

Current LAN IP re-verified via `ipconfig` (not assumed unchanged from Spike
D's `192.168.1.64`): now `192.168.1.66`.

Adapter restarted (`PORT=4100 npm start`, same seeded credentials Spike C's
own README documents):

```
[adapter-server] listening on http://127.0.0.1:4100
```

Binding, confirmed via `netstat -ano | findstr :4100`:

```
TCP    127.0.0.1:4100         0.0.0.0:0              LISTENING       <pid>
```

(Previously: `0.0.0.0:4100` and `[::]:4100` — both now absent.)

Loopback request succeeds:

```
$ curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://127.0.0.1:4100/health
{"status":"ok","role":"spike-c-adapter-server"}
HTTP_STATUS:200
```

LAN-IP request fails (connection refused, not a timeout — the OS itself
rejects it because nothing is listening on that interface):

```
$ curl -s -v --max-time 6 http://192.168.1.66:4100/health
*   Trying 192.168.1.66:4100...
* connect to 192.168.1.66 port 4100 from 0.0.0.0 port 64585 failed: Connection refused
* Failed to connect to 192.168.1.66:4100 after 2045 ms: Could not connect to server
```

This is the actual proof of containment — not the CORS change.

### Spike C's own smoke test (5 assertions): re-run, all PASS

Re-run exactly per this spike's own README (copy into
`spike-a-standalone-shell/upstream/`, Spike A's build served on port 4173
via `npx sirv build/ --single --port 4173`, against the now-loopback-bound,
CORS-restricted adapter):

| Assertion | Result |
|---|---|
| homepage-renders-real-content | PASS |
| homepage-shows-real-athernull-task-title | PASS |
| click-through-to-conversation-detail | PASS |
| conversation-detail-shows-real-seeded-events | PASS |
| websocket-status-recorded | PASS |

(WebSocket attempts still fail with 404, as originally documented — that's
Spike C's own pre-existing, unrelated finding #4, not a regression from this
fix.)

### Spike D's smoke test (6 assertions): re-run, all PASS

Re-run against `/harness-live` (`spike-b-selective-reuse`, served on port
3902 with `.env.local`'s `NEXT_PUBLIC_ADAPTER_BASE=http://localhost:4100`):

| Assertion | Result |
|---|---|
| loading-completed-before-assertions | PASS |
| exact-seeded-conversation-title-present | PASS |
| distinctive-seeded-event-message-present | PASS |
| terminal-shows-seeded-command | PASS |
| terminal-shows-seeded-output | PASS |
| zero-console-errors | PASS |

No allowlist adjustment was needed — `http://localhost:3902` and
`http://localhost:4173` were correct on the first try (traced from each
spike's own README, not guessed).

## What this fix does NOT change (restated, not re-fixed)

Two things Spike D already found remain true and are untouched by this
adapter-binding/CORS fix:

- Terminal output in `/harness-live` is a **replay of fetched historical
  text, not an interactive PTY** — no live input, no running process.
- Only 5 of the 9 seeded events render as distinct real text at rest in
  `/harness-live`. The 2 file-editor action/observation pairs (4 events)
  collapse into an untranslated i18n-key literal
  (`EVENT_GROUP$ACTIONS_COMPLETED`, expanding to
  `OBSERVATION_MESSAGE$RUN`/`WRITE`/`EDIT`); their real content (file paths,
  diffs) is not visible anywhere on the page. A passing smoke test does
  **not** imply this is resolved — this task's scope was network
  containment only, and neither assertion set exercises this gap.
