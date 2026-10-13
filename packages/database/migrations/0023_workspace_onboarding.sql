-- Faster, visible workspace onboarding (docs/architecture/WORKSPACE_ONBOARDING.md).
--
-- 1. agent_sandbox_requests.phase: how far the provisioner has got, so the
--    canvas setup screen shows real progress instead of a spinner.
alter table agent_sandbox_requests
    add column phase text check (phase in ('QUEUED', 'STARTING', 'BOOTING', 'CONFIGURING', 'READY')),
    add column started_at timestamptz;

-- 2. The warm pool: generic sandboxes, booted and configured ahead of time,
--    handed to a NEW organization in one transaction (the row is deleted as
--    the organization's org_agent_servers row is written). A pool sandbox
--    holds no organization data — only the deployment's LLM settings and the
--    AtherNull Builds extension — and is discarded when the sandbox run
--    policy or that configuration changes (the two fingerprints).
create table sandbox_pool (
    container_name      text primary key check (container_name ~ '^athernull-sandbox-[0-9a-f]{8}$'),
    base_url            text not null,
    session_api_key     text not null check (length(session_api_key) >= 32),
    policy_fingerprint  text not null,
    config_fingerprint  text not null,
    status              text not null default 'WARMING' check (status in ('WARMING', 'READY')),
    created_at          timestamptz not null default now(),
    ready_at            timestamptz
);

create index on sandbox_pool (status, ready_at);
