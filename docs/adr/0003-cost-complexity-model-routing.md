# ADR-0003: Cost/complexity-based model routing

Status: Proposed
Date: 2026-09-19

## Context

The platform must not be locked to one LLM provider or one model per org (spec's `agent_profiles`
table and OpenHands' own provider-agnostic design both assume this). Beyond just *supporting* any
model, the requirement is to route work to a cheaper/faster model for simple tasks and a more
capable one for complex tasks automatically, rather than making every client pick a single fixed
model for every task.

This changes the `agent_profiles.model` field (spec §5, currently a single string) into something
richer, and introduces a decision that has to be made, recorded, and auditable — not just a hidden
runtime choice inside the worker.

## Decision

1. **Where it happens**: routing is computed by the orchestrator/API at dispatch time, before the
   worker ever starts (spec's service table: worker owns SDK invocation, not dispatch decisions).
   The worker receives an already-resolved model string in the internal work dispatch payload; it
   never chooses its own model.
2. **`agent_profiles.model` becomes `agent_profiles.model_tiers`**: an ordered array of
   `{ tier, model, maxComplexity, costCeilingMinor? }`, cheapest/simplest first. Orgs still control
   which models are allowed at all — they just no longer have to hand-pick one per task.
3. **v1 complexity signal is a rule-based heuristic, not ML**: computed from data already available
   at task-creation time — objective text length, a small static keyword list (`migrate`,
   `refactor`, `rewrite`, `architecture` push complexity up; `typo`, `rename`, `copy` push it down),
   and `acceptanceCriteria.length`. This is deliberately cheap and inspectable; replacing it with a
   learned classifier is a later decision, not blocked by this one.
4. **Budget is itself a signal, not just a cap**: a tier is only eligible if
   `costCeilingMinor <= task.budgetMinor` (when set). The router picks the highest-complexity tier
   that's both justified by the score and affordable, falling back to the cheapest tier if nothing
   else fits.
5. **The decision is recorded, not silent**: `executions` gains `routing_tier`, `routing_score`,
   and `routing_reason` columns. A disputed or surprising model choice must be explainable from the
   audit trail, matching the platform's existing non-negotiable rule that nothing is trusted
   without a durable record.
6. **Escalation on failure is out of scope for v1**: retrying a failed/incomplete execution one
   tier up within the same total budget is a natural extension (ties into Phase 1's lease/retry
   logic) but is not built now — noted here so Phase 1 doesn't foreclose it.

## Consequences

- `packages/model-router` is a new pure-logic package: no I/O, easy to unit test, callable from
  the API once Phase 1's job engine exists.
- Schema changes needed before Phase 1 ships: `agent_profiles.model_tiers` replaces `.model`;
  `executions` gains the three routing columns. Made now, before any real data exists, rather than
  as a later migration.
- The heuristic will misclassify some tasks. That's acceptable for v1 as long as: (a) it's cheap
  enough that a wrong guess doesn't blow the budget, and (b) the reason is recorded so it can be
  reviewed and the keyword/threshold list tuned.
