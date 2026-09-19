# services/verifier

Independent verification. Owns: fresh checkout, deterministic tests, policy checks, evidence
(spec §3). Must not own: self-certification based solely on the agent's own report.

Deliberately has no dependency on `workers/coding-agent` or the OpenHands SDK — it must not share
process, state or assumptions with the worker it's checking (spec §8 "Verification contract").

Phase 4 stub — real checks land once Phase 1–3 produce a real artifact to verify.
