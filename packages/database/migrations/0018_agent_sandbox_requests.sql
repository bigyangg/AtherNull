-- ADR-0018: an organization's agent workspace is created on demand. Opening
-- the canvas without one records a request here (any member); the sandbox
-- provisioner — a separate, privileged process with Docker access, never
-- apps/api — creates the sandbox and marks it done. apps/api never runs
-- Docker itself.
create table agent_sandbox_requests (
    organization_id     uuid primary key references "organization"(id),
    requested_by        uuid not null references "user"(id),
    status              text not null default 'PENDING'
        check (status in ('PENDING', 'PROVISIONING', 'READY', 'FAILED')),
    attempts            integer not null default 0,
    error               text,
    claimed_at          timestamptz,
    requested_at        timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
