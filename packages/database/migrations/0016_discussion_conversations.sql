-- Pre-funding discussions (ADR-0016): conversations started from the Agent
-- Canvas run a tool-less "discussion" agent (talk and plan only) so people
-- can scope work before paying. The gateway records each one here; this
-- table — not a tag the sandbox reports back — is what lets a later chat
-- message through, and it carries the caps that keep discussions cheap.
create table discussion_conversations (
    conversation_id     text primary key,
    organization_id     uuid not null references "organization"(id),
    created_by          uuid not null references "user"(id),
    message_count       integer not null default 1 check (message_count >= 0),
    created_at          timestamptz not null default now(),
    last_message_at     timestamptz not null default now()
);

create index on discussion_conversations (organization_id, created_at desc);
