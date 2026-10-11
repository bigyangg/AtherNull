# ADR-0016: Discuss before funding

Status: Accepted, implemented and verified locally
Date: 2026-10-11
Amends ADR-0015 (agent gateway policy).

## Context

ADR-0015 only let the agent work inside a funded, running build, so the
canvas could not hold a conversation at all: people had to pay before they
could talk the work through. Customers need to discuss and agree on scope
first, then approve a plan, then fund it.

## Decision

1. **Sign in lands in the canvas.** `APP_HOME` (`/canvas` by default,
   `NEXT_PUBLIC_APP_HOME` to override) is where sign-in, email verification
   and signed-in visits to `/` or auth pages go. If the org has no sandbox,
   the canvas sends the user to `/dashboard?sandbox=missing`, which explains
   how to provision one.

2. **Starting a conversation starts a discussion.** `POST /api/conversations`
   from the canvas is classified `discuss`. The gateway never forwards the
   browser's request: it builds a discussion agent itself, using only the
   opening message text:
   - `tools: []`, `mcp_config: {}`, no skills — it can only talk (no
     terminal, files, browser or MCP);
   - planning instructions: ask scoping questions, propose deliverables and
     testable acceptance criteria, then point to "Turn into a build";
   - platform LLM (`DISCUSSION_LLM_MODEL`, NIM key), `max_iterations` 6,
     working dir `/workspace/discussions/<id>`.

3. **Discussions are recorded and capped** (`discussion_conversations`,
   migration 0016): the gateway records each one before creating it, and
   that row — not a tag reported by the sandbox — is what admits later chat.
   Any org member may chat (`/events`, `/run`, `/ask_agent`, `/condense`,
   and the events socket), up to `DISCUSSION_MAX_MESSAGES` (40) per
   discussion and `DISCUSSION_MAX_PER_ORG_PER_DAY` (30) new ones. Switching
   the model or profile, loading plugins, forking etc. stay funded-build
   only (owner/admin + RUNNING), unchanged.

4. **Turn into a build.** AtherNull Builds lists the org's discussions
   (`GET /v1/discussions`). Choosing one and a repository calls
   `POST /v1/projects/:id/estimates { discussionId }`: apps/api reads the
   transcript from the org's sandbox server-side (only that org's
   discussions resolve) and plans from it; the client never supplies the
   transcript. From there it is the existing flow: approve the plan,
   authorize a budget, fund on devnet, the fully-tooled build runs.

5. Canvas patch 0001 (hand conversation creation to Builds) is removed: the
   canvas creates conversations normally and the gateway decides what they
   are.

## Consequences

- People can talk before paying; the platform pays for discussion tokens,
  bounded by the caps above and by the agent having no tools.
- A discussion cannot change code or reach the network; only a funded
  build can.
- Discussions created before this ADR, or directly on the sandbox, are not
  in the ledger and cannot be continued or planned from.
- Not yet: per-user caps, token-based (rather than message-based) caps,
  carrying the discussion into the build conversation as its parent.
