-- ADR-0019 — commits as the record of work. Every project's code lives in
-- a bare repository AtherNull hosts (REPOS_ROOT/<org>/<project>.git); git
-- is the source of truth for content, these columns cache commit ids.

-- 'hosted' once the project has its repository (created new, or imported
-- from permitted_repository); null = not imported yet (imported lazily the
-- first time a build is dispatched). 'github' arrives with phase 2.
alter table projects add column repo_kind text check (repo_kind in ('hosted', 'github'));

alter table tasks
    -- The commit the build starts from (pinned when first dispatched).
    add column base_commit   text check (base_commit   ~ '^[0-9a-f]{40}$'),
    -- The build's single commit on builds/<task id>, once received.
    add column result_commit text check (result_commit ~ '^[0-9a-f]{40}$'),
    -- What main became when the build was accepted.
    add column merged_commit text check (merged_commit ~ '^[0-9a-f]{40}$'),
    -- Accepting onto a main that moved: VERIFYING (merged result under
    -- test) or CONFLICT (cannot be accepted as is).
    add column merge_state   text check (merge_state in ('VERIFYING', 'CONFLICT'));

-- Pinned commits never change once set.
create function tasks_commits_guard() returns trigger as $$
begin
    if (old.base_commit is not null and new.base_commit is distinct from old.base_commit)
        or (old.merged_commit is not null and new.merged_commit is distinct from old.merged_commit) then
        raise exception 'tasks: a pinned commit is immutable';
    end if;
    return new;
end;
$$ language plpgsql;

create trigger tasks_commits_guard before update on tasks
    for each row execute function tasks_commits_guard();

-- The commit an execution produced; the verifier checks out exactly this.
-- Null for patches captured before ADR-0019 (verified by applying the patch).
alter table execution_patches add column result_commit text check (result_commit ~ '^[0-9a-f]{40}$');
