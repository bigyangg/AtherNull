# packages/contracts

Shared API/event schemas (Zod) consumed by `apps/api` and `workers/coding-agent` (via generated
types or a mirrored Python model — TBD). These are the proposed interface shapes from spec §7, not
confirmed OpenHands SDK signatures; SDK-specific calls stay behind the worker's own adapter so
upgrades don't change this contract.
