-- Agent Server integration, step 2: persist the event stream an execution's
-- Agent Server produces (previously discarded the moment conversation.run()
-- returned). id is the OpenHands event's own uuid, not a generated one — that
-- makes forwarding idempotent for free: replaying an Agent Server's event
-- history after a gap (resend_mode=all/since, see the coding-agent worker's
-- agent_server_adapter.py) can be inserted with ON CONFLICT DO NOTHING
-- instead of needing separate dedupe bookkeeping.
create table execution_events
(
    id           uuid primary key,
    execution_id uuid        not null references executions (id),
    kind         text        not null,
    payload      jsonb       not null,
    occurred_at  timestamptz not null,
    created_at   timestamptz not null default now()
);

create index on execution_events (execution_id, occurred_at);
