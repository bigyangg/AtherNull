-- Request changes: after a build is verified, the customer can send it back
-- to the agent with feedback instead of only accepting or rejecting it. The
-- next attempt continues from the delivered version (from_commit), on the
-- same funding, and is verified again. Rounds are capped per task by the API
-- (routes/change-requests.ts); the unique (task_id, round) makes a double
-- submit impossible.
create table task_change_requests (
    id              uuid primary key default gen_random_uuid(),
    task_id         uuid not null references tasks(id),
    organization_id uuid not null references "organization"(id),
    round           integer not null check (round between 1 and 10),
    feedback        text not null check (length(feedback) between 1 and 4000),
    -- The delivered commit the agent continues from (hosted repositories).
    from_commit     text check (from_commit ~ '^[0-9a-f]{40}$'),
    requested_by    uuid not null references "user"(id),
    created_at      timestamptz not null default now(),
    unique (task_id, round)
);

create index on task_change_requests (task_id, round);
