# Deferred work — pick up later

Not urgent, not forgotten. Update/remove items here as they land.

## Landing page copy (apps/web)

Whitepaper (`apps/web/app/whitepaper/page.tsx`) now uses the Estimate → Approve →
Execute → Verify → Settle vocabulary. Landing page still doesn't mention "estimate"
or explicit settlement anywhere. Decided to leave it alone for now — proposed,
not applied:

- `apps/web/components/landing/workflow-story.tsx` — `STEPS` array:
  - Step 1 ("Brief the task") text: "Name the outcome, choose the repository, and
    set the maximum you are willing to spend." → add the missing estimate, e.g.
    "...and see the estimated cost before you set a budget."
  - Step 3 ("Approve the result") text: make settlement explicit, e.g. "Review the
    pull request, test results, and final cost, then approve to release payment or
    send it back."
  - This component is a heavily choreographed GSAP scrollytelling piece with
    hardcoded screen mockups (`BriefScreen`/`AgentScreen`/`ReviewScreen`) — these
    are copy tweaks only, not a restructure into 5 named steps.
- **Leave unchanged** (different narratives, not the money lifecycle, renaming
  would misrepresent them):
  - `apps/web/components/landing/ownership-flow.tsx` — 6-stage general dev-cycle
    animation (Brief/Plan/Execute/Validate/Review/Observe).
  - `apps/web/components/landing/integration-flow.tsx` — 3-step tool-handoff
    illustration (Request/Agent workspace/Review).
- `apps/web/app/page.tsx` `PRINCIPLES` array — low priority, currently fine as-is;
  could tweak "Escrow until review" → "...held until you verify and accept the
  result" to mirror the verify step, but not required.

## Docs page (still using the old 4-stage vocabulary)

`apps/web/app/docs/page.tsx:15-20` `STAGES` array still says "Define → Run →
Verify → Decide", never naming "Estimate" or "Settle", even though the budget/
escrow section right below it describes exactly that mechanism. Update `STAGES`
to Estimate/Approve/Execute/Verify/Settle (including the "transparent quotation"
step from the original diagram) once this feels worth doing.

## Backend — explicitly deferred when Estimate/Verify/Accept/Reject shipped

From the plan at the time (`apps/api/src/routes/jobs.ts`, `packages/contracts`):

- A generic refund path for `FAILED`/`CANCELLED` tasks that exhausted retries,
  and `DISPUTED` handling — both need their own review of who's allowed to
  trigger them.
- `EventEnvelopeSchema`/`audit_events` (`packages/contracts/src/events.ts`) have
  zero producers wired up anywhere in the codebase. Wiring them is a separate,
  larger change (needs an emitter/queue decision).
- Real Solana settlement (`packages/solana-client` → `apps/api`) stays out per
  `contracts/solana/plansol.md`'s locked-in sequencing decision — don't wire it
  in until Phases 1–4 (task engine, worker adapter, sandbox, verifier) all exist.
- Partial-release settlement (paying out actual spend instead of full
  `max_budget_minor` on accept) — current `accept` handler always settles the
  full budget; refining this to release actual usage + return the remainder is
  a later pass.
