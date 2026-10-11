-- Phase 4 — independent verification (ADR-0017). The worker captures the
-- exact change its agent made (a git diff against the approved revision) as
-- the execution's artifact; a separate verifier service applies it to a
-- fresh checkout and runs the project's tests. The verifier never sees the
-- worker's own success claim, only this patch.
create table execution_patches (
    execution_id            uuid primary key references executions(id),
    task_id                 uuid not null references tasks(id),
    organization_id         uuid not null references "organization"(id),
    base_revision           text not null,
    patch                   text not null,
    sha256                  text not null check (sha256 ~ '^[0-9a-f]{64}$'),
    files_changed           integer not null check (files_changed >= 0),
    insertions              integer not null check (insertions >= 0),
    deletions               integer not null check (deletions >= 0),
    created_at              timestamptz not null default now(),
    -- Verifier claim (one verifier at a time per execution).
    verify_lease_owner      text,
    verify_lease_expires_at timestamptz,
    check ((verify_lease_owner is null) = (verify_lease_expires_at is null))
);

create index on execution_patches (task_id);

-- The patch is the artifact; it never changes once captured.
create function execution_patches_guard() returns trigger as $$
begin
    if new.patch <> old.patch or new.sha256 <> old.sha256 or new.base_revision <> old.base_revision
        or new.execution_id <> old.execution_id or new.task_id <> old.task_id then
        raise exception 'execution_patches: a captured patch is immutable';
    end if;
    return new;
end;
$$ language plpgsql;

create trigger execution_patches_immutable
    before update on execution_patches
    for each row execute function execution_patches_guard();
