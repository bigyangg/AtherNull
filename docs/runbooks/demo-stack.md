# Running the full AtherNull demo stack locally

Everything on one origin, `http://localhost:8080` (ADR-0015):

| Path | Service |
|---|---|
| `/canvas` | OpenHands Agent Canvas (pinned + patched) |
| `/oh` | Agent gateway → your org's sandboxed Agent Server |
| `/api/auth`, `/v1` | AtherNull API |
| everything else | AtherNull web app |

## One-time setup

```sh
pnpm install
docker compose -f infrastructure/docker-compose.yml up -d postgres
# apply packages/database/migrations/*.sql in order (0001 … 0016)
node apps/canvas/setup.mjs      # pinned Agent Canvas + AtherNull patch
node apps/canvas/build.mjs      # brands + builds; CANVAS_PUBLIC_ORIGIN defaults to http://localhost:8080
docker pull ghcr.io/openhands/agent-server:latest-python
```

`apps/api/.env` (see `.env.example`) must use the single origin:

```
BETTER_AUTH_URL=http://localhost:8080
WEB_APP_URL=http://localhost:8080
TRUSTED_ORIGINS=http://localhost:8080
NVIDIA_NIM_API_KEY=...            # planner + sandbox LLM
SOLANA_RPC_URL=... SOLANA_AUTHORITY_KEYPAIR=...   # devnet funding/settlement
```

`apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:8080`.

## Start (one terminal each)

```sh
pnpm --filter @athernull/api dev
pnpm --filter @athernull/web dev
CANVAS_DIST=apps/canvas/upstream/build node infrastructure/ingress/dev-ingress.mjs
cd workers/coding-agent && EXECUTION_ADAPTER=org_sandbox .venv/Scripts/python -m coding_agent.worker
```

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
5. Verify → **Accept & release payment** (settles on devnet) or **Reject &
   refund**; a failed build offers **Refund deposit**. Each payout links to
   Solana Explorer.

Discussions are tool-less and capped (ADR-0016); agent work with tools only happens inside a funded, running build (402 otherwise).
The devnet program must include the 4E.2 settle/refund instructions
(ADR-0014) for step 4.
