# packages/model-router

Cost/complexity-based model routing (ADR-0003, `docs/adr/0003-cost-complexity-model-routing.md`).

Pure logic, no I/O — called by the API/orchestrator at task dispatch time, never by the worker.
The worker receives an already-resolved model string; it does not choose its own model.

`scoreComplexity()` is a v1 rule-based heuristic (text length + static keyword list + acceptance
criteria count), not ML. It will misclassify some tasks — that's acceptable as long as a wrong
guess is cheap and the reason is recorded (`chooseTier()` always returns a human-readable
`reason`), so the keyword/threshold list can be tuned from real outcomes instead of guessed at
twice.
