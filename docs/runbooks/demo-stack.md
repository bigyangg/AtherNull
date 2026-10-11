# Running the full AtherNull demo stack locally

Everything on one origin, `http://localhost:8080` (ADR-0015):

| Path | Service |
|---|---|
| `/canvas` | OpenHands Agent Canvas (pinned + patched) |
| `/oh` | Agent gateway → your org's sandboxed Agent Server |
| `/api/auth`, `/v1` | AtherNull API |
| everything else | AtherNull web app |

## One command

```sh
pnpm install
node scripts/dev.mjs --init-env   # first time: writes apps/api/.env from ~/.athernull-devnet
pnpm dev                          # afterwards
```

`scripts/dev.mjs` starts Postgres, applies migrations (recording any that a
hand-built database already has), builds the canvas on first run, prepares
the demo repository (`~/.athernull/demo-api`, from `examples/demo-api`),
then runs API, web, ingress, the worker (`org_sandbox`) and the independent
verifier with prefixed logs. It refuses to start if 3000, 3001 or 8080 is
taken. Ctrl-C stops everything. Needs Docker and the worker venv
(`workers/coding-agent/.venv`).

## Per organization

Sign up at `http://localhost:8080`, create an organization, then:

```sh
pnpm --filter @athernull/api sandbox:provision -- --org <organizationId>
```

This starts `athernull-sandbox-<id>` on a loopback port, registers it,
configures the NIM model, turns telemetry off and installs the AtherNull
Builds extension. Re-running it is safe.

## Demo path

1. Sign in at `http://localhost:8080` — you land in the canvas (Customize:
   MCP, skills, plugins; Builds).
2. Talk to the agent: describe what you want. It is a discussion agent with
   no tools — it asks questions and proposes deliverables and acceptance
   criteria. Nothing is charged.
3. **AtherNull Builds → Your discussions → Turn into a build**: pick the
   repository; the plan is drafted from the discussion → approve → authorize
   budget → prepare → fund on Solana devnet (Phantom/Solflare on devnet) →
   activate.
4. The worker runs the build as a conversation in your sandbox, with full
   tools: open it from Builds ("Watch and steer the agent live in the
   canvas") or the conversation list; owners/admins can message it while it
   runs.
5. The independent verifier applies the captured change to a fresh checkout
   and runs the tests with no network; the build moves to review (or fails)
   on its own. Changes shows the exact diff; Checks shows the evidence.
6. **Accept & release payment** (settles on devnet) or **Reject & refund**;
   a failed build offers **Refund deposit**. Each payout links to Solana
   Explorer.

Use the demo repository (`~/.athernull/demo-api`) as the project: e.g.
"Add GET /version that returns the package.json version, with a test".

Discussions are tool-less and capped (ADR-0016); agent work with tools only happens inside a funded, running build (402 otherwise).
The devnet program must include the 4E.2 settle/refund instructions
(ADR-0014) for step 4.
