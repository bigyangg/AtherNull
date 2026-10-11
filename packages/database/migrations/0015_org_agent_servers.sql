-- ADR-0015: each organization's own sandboxed OpenHands Agent Server, which
-- the real Agent Canvas reaches only through apps/api's agent gateway.
--
-- session_api_key is the sandbox's own credential. It never leaves apps/api
-- (the gateway injects it upstream; the browser never sees it) and the
-- sandbox it unlocks is bound to loopback / a private network, so the key
-- alone is not a network path to it.
create table org_agent_servers (
    organization_id     uuid primary key references "organization"(id),
    base_url            text not null check (base_url ~ '^https?://'),
    session_api_key     text not null check (length(session_api_key) >= 32),
    container_name      text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
