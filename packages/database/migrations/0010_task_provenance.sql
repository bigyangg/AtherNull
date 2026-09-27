-- Phase 4C — Provenance-Bound Task Creation and Execution Activation Gate.
--
-- Closes the long-standing tasks/projects tenant-integrity gap — the
-- historical-data preflight (human-reviewed, see this migration's own PR/
-- commit context) confirmed zero existing tasks violate this, so this is a
-- pure additive constraint with no data rewrite.
alter table tasks add constraint tasks_project_id_organization_id_unique
    foreign key (project_id, organization_id) references projects (id, organization_id);

-- Additive uniqueness needed for the new composite FKs below.
alter table project_estimates add constraint project_estimates_id_project_id_unique unique (id, project_id);
alter table project_budget_authorizations add constraint pba_id_organization_id_unique unique (id, organization_id);
alter table project_budget_authorizations add constraint pba_id_estimate_id_unique unique (id, estimate_id);

-- Nullable provenance columns — NULL for all existing historical tasks (no
-- backfill, no fabrication). Half-provenance is impossible by construction:
alter table tasks add column source_estimate_id uuid references project_estimates(id);
alter table tasks add column source_budget_authorization_id uuid references project_budget_authorizations(id);
alter table tasks add constraint tasks_provenance_paired check (
    (source_estimate_id is null) = (source_budget_authorization_id is null)
);

-- Chain-of-trust composite FKs: task's estimate must belong to the task's
-- own project; task's authorization must belong to the task's own
-- organization AND target the task's own exact estimate (not just any
-- estimate) — this last one is load-bearing, proving the authorization was
-- actually issued for the estimate stored on the task, not two
-- independently-valid-but-mismatched rows.
alter table tasks add constraint tasks_source_estimate_project_fkey
    foreign key (source_estimate_id, project_id) references project_estimates (id, project_id);
alter table tasks add constraint tasks_source_authorization_org_fkey
    foreign key (source_budget_authorization_id, organization_id) references project_budget_authorizations (id, organization_id);
alter table tasks add constraint tasks_source_authorization_estimate_fkey
    foreign key (source_budget_authorization_id, source_estimate_id) references project_budget_authorizations (id, estimate_id);

-- Final DB-level backstop: one authorization can never produce two tasks,
-- even if application-level locking somehow fails.
create unique index tasks_one_per_source_budget_authorization
    on tasks (source_budget_authorization_id) where source_budget_authorization_id is not null;

-- Extend the status enum to add CONSUMED — historical ACTIVE/SUPERSEDED
-- semantics unchanged.
alter table project_budget_authorizations drop constraint project_budget_authorizations_status_check;
alter table project_budget_authorizations add constraint project_budget_authorizations_status_check
    check (status in ('ACTIVE','SUPERSEDED','CONSUMED'));
