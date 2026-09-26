-- Phase 4A — Project Scope, Build Plan and Cost Estimate.
--
-- Enables the composite FK below without altering any existing behavior —
-- projects.id is already the primary key (globally unique on its own); this
-- unique constraint additionally lets (id, organization_id) be referenced
-- together, so a child row cannot claim an organization_id that doesn't
-- actually match the project it points to. Purely additive; does not touch
-- `tasks` or any other existing table, which retain their current
-- (unenforced-at-DB-level) organization_id/project_id pairing as a
-- deliberately out-of-scope, pre-existing condition for this phase.
alter table projects add constraint projects_id_organization_id_unique unique (id, organization_id);

create table project_estimates (
    id                  uuid primary key default gen_random_uuid(),

    lineage_id          uuid not null,
    version             integer not null,

    status              text not null default 'DRAFT'
                        check (status in ('DRAFT','READY_FOR_REVIEW','APPROVED','SUPERSEDED')),

    organization_id     uuid not null references "organization"(id),
    project_id          uuid not null references projects(id),
    -- Tenant-integrity: project_id's organization_id must match this row's
    -- own organization_id, enforced by Postgres itself, not just app code.
    foreign key (project_id, organization_id) references projects (id, organization_id),

    source_prompt       text not null,

    planner_output      jsonb not null,
    planner_model       text not null,

    pricing_status      text not null default 'UNPRICED'
                        check (pricing_status in ('UNPRICED','PRICED')),

    currency                  text,
    estimated_min_minor       bigint,
    estimated_max_minor       bigint,
    proposed_budget_cap_minor bigint,

    pricing_breakdown   jsonb,
    rate_version        text,

    created_by          uuid not null references "user"(id),
    created_at          timestamptz not null default now(),

    approved_by         uuid references "user"(id),
    approved_at         timestamptz,

    constraint project_estimates_lineage_version_unique
        unique (lineage_id, version),

    -- Both null or both set — independent of current `status`, so a
    -- SUPERSEDED row that WAS approved keeps its historical approved_by/
    -- approved_at forever (this is the corrected semantics — the earlier
    -- draft of this constraint wrongly forced approval metadata to null
    -- whenever status != APPROVED, which would have destroyed audit history
    -- on every supersede).
    constraint project_estimates_approval_pair
        check ((approved_by is null) = (approved_at is null)),

    -- A row currently APPROVED must have approval metadata. (The converse —
    -- SUPERSEDED retaining approval metadata — is deliberately NOT
    -- constrained away; see comment above.)
    constraint project_estimates_approved_requires_metadata
        check (status <> 'APPROVED' or approved_at is not null),

    -- PRICED requires all four monetary fields; UNPRICED requires none of
    -- them (never a partially-priced row).
    constraint project_estimates_pricing_completeness
        check (
            (pricing_status = 'UNPRICED' and currency is null and estimated_min_minor is null
                and estimated_max_minor is null and proposed_budget_cap_minor is null)
            or
            (pricing_status = 'PRICED' and currency is not null and estimated_min_minor is not null
                and estimated_max_minor is not null and proposed_budget_cap_minor is not null)
        ),

    constraint project_estimates_price_order
        check (
            estimated_min_minor is null
            or (estimated_min_minor >= 0
                and estimated_max_minor >= estimated_min_minor
                and proposed_budget_cap_minor >= estimated_max_minor)
        )
);

create index project_estimates_project_idx on project_estimates (project_id);
create index project_estimates_org_idx on project_estimates (organization_id);
create index project_estimates_lineage_idx on project_estimates (lineage_id);

-- At most one APPROVED row per lineage, enforced by Postgres, not just app
-- logic — a concurrent double-approve of two different versions in the same
-- lineage is rejected by this index, not merely by the guarded UPDATE below.
create unique index project_estimates_one_approved_per_lineage
    on project_estimates (lineage_id) where status = 'APPROVED';
