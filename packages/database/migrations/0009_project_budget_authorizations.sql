-- Phase 4B — Authorized Project Budget and Build Activation Boundary.
--
-- Additive uniqueness needed for the composite FKs below. project_estimates
-- did not need either of these for Phase 4A's own composite FK (which only
-- tied project_id to organization_id via projects) — this phase's table
-- needs two more:
--
-- 1. (id, organization_id) — so a project_budget_authorizations row's
--    estimate_id and organization_id can be tied together at the DB level
--    (closes the gap where a row could otherwise reference a real
--    estimate_id belonging to a DIFFERENT organization than the one the
--    authorization row itself claims).
alter table project_estimates add constraint project_estimates_id_organization_id_unique unique (id, organization_id);

-- 2. (id, lineage_id, version) — project_estimates only had
--    unique(lineage_id, version) before this phase; `id` alone is already
--    globally unique via its primary key, but Postgres composite foreign
--    keys require a unique constraint on the EXACT column tuple being
--    referenced, and (id, lineage_id, version) as a tuple has no such
--    constraint until this line. Without it, the exact-version-identity FK
--    below (guaranteeing that a given estimate_id + estimate_lineage_id +
--    estimate_version genuinely belong together, not just that estimate_id
--    exists) could not be declared at all.
alter table project_estimates add constraint project_estimates_id_lineage_id_version_unique unique (id, lineage_id, version);

create table project_budget_authorizations (
    id                  uuid primary key default gen_random_uuid(),

    organization_id     uuid not null references "organization"(id),
    project_id          uuid not null references projects(id),
    foreign key (project_id, organization_id) references projects (id, organization_id),

    estimate_id         uuid not null references project_estimates(id),
    estimate_lineage_id uuid not null,
    estimate_version    integer not null,
    -- Exact-version identity: the (id, lineage_id, version) tuple must
    -- genuinely belong together, not just estimate_id alone.
    foreign key (estimate_id, estimate_lineage_id, estimate_version)
        references project_estimates (id, lineage_id, version),
    -- Tenant integrity: estimate_id's own organization_id must equal this
    -- row's organization_id, enforced by Postgres, not just app code —
    -- closes the gap where the two FKs above could otherwise each be
    -- independently satisfied by rows from two different organizations.
    foreign key (estimate_id, organization_id) references project_estimates (id, organization_id),

    amount_minor        bigint not null check (amount_minor > 0 and amount_minor <= 100000000000),
    currency            text not null,
    source              text not null check (source in ('ESTIMATE_PROPOSED_CAP','USER_SET')),
    status              text not null default 'ACTIVE' check (status in ('ACTIVE','SUPERSEDED')),

    -- Corrections/re-authorizations chain: null for the first authorization
    -- of a given estimate, otherwise points at the row this one replaces.
    -- Historical rows are NEVER updated in place — every correction is a
    -- new row.
    supersedes_id       uuid references project_budget_authorizations(id),

    authorized_by       uuid not null references "user"(id),
    authorized_at       timestamptz not null default now(),
    created_at          timestamptz not null default now()
);

create index on project_budget_authorizations (project_id);
create index on project_budget_authorizations (organization_id);
create index on project_budget_authorizations (estimate_id);

-- At most one ACTIVE authorization per EXACT estimate (not lineage) — v2 and
-- v3 of the same lineage each get their own independent ACTIVE row; no
-- inheritance across versions, per the approved policy.
create unique index project_budget_authorizations_one_active_per_estimate
    on project_budget_authorizations (estimate_id) where status = 'ACTIVE';
