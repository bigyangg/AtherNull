-- Phase 4E.1 — Solana Devnet Project Account + Funding Gate (ADR-0013).
--
-- DEVNET ONLY, DEVNET_SOL ONLY, integer lamports only. This is a clean
-- funding-domain model: payment_intents is historical legacy state and is
-- deliberately not reused (its rows are stub semantics — no network,
-- signature, slot, or account). Nothing here relates budget authorization
-- amount_minor to lamports: required_amount_base_units is an explicit,
-- separately-sourced DEMO_FIXED requirement snapshotted at creation.

-- Needed so a funding account can prove "my budget authorization is exactly
-- the one this task was created from" with a composite FK (the same pattern
-- 0010 used for the task -> estimate/authorization chain).
alter table tasks add constraint tasks_id_source_budget_authorization_id_unique
    unique (id, source_budget_authorization_id);

create table project_funding_accounts (
    id                          uuid primary key default gen_random_uuid(),

    organization_id             uuid not null references "organization"(id),
    project_id                  uuid not null references projects(id),
    task_id                     uuid not null,
    budget_authorization_id     uuid not null references project_budget_authorizations(id),

    -- Tenant/provenance integrity enforced by the database, not just the API:
    -- the funding row's org/project/task must be exactly one real task row,
    -- and its budget authorization must be exactly that task's
    -- source_budget_authorization_id.
    foreign key (task_id, project_id, organization_id) references tasks (id, project_id, organization_id),
    foreign key (task_id, budget_authorization_id) references tasks (id, source_budget_authorization_id),

    -- Explicit network + provider, never inferred from a hostname.
    network                     text not null check (network = 'devnet'),
    rpc_provider                text not null check (rpc_provider = 'helius'),
    asset_type                  text not null check (asset_type = 'DEVNET_SOL'),

    program_id                  text not null,
    onchain_account             text not null,
    -- SHA-256 provenance binding (packages/solana-client computeBindingHash).
    binding_hash                bytea not null check (octet_length(binding_hash) = 32),

    -- NULL until the first Prepare Funding binds the connected wallet; then
    -- immutable (enforced by project_funding_accounts_immutable below).
    customer_wallet             text,
    customer_bound_at           timestamptz,
    check ((customer_wallet is null) = (customer_bound_at is null)),

    -- DEMO_FIXED only: never derived from budget amount, NIM usage, USD or FX.
    requirement_source          text not null check (requirement_source = 'DEMO_FIXED'),
    required_amount_base_units  bigint not null check (required_amount_base_units > 0),

    -- Sum of verified, finalized deposit rows. Lamports (integer) only.
    confirmed_amount_base_units bigint not null default 0 check (confirmed_amount_base_units >= 0),

    status                      text not null default 'AWAITING_FUNDS'
        check (status in ('AWAITING_FUNDS', 'PARTIALLY_FUNDED', 'FUNDED')),
    -- Status is a pure function of the amounts; the DB refuses any row where
    -- they disagree.
    check (
        (status = 'AWAITING_FUNDS' and confirmed_amount_base_units = 0)
        or (status = 'PARTIALLY_FUNDED' and confirmed_amount_base_units > 0
            and confirmed_amount_base_units < required_amount_base_units)
        or (status = 'FUNDED' and confirmed_amount_base_units >= required_amount_base_units)
    ),

    -- On-chain initialize_project_funding (authority-signed) evidence.
    -- init_signature/init_sent_at record the latest SENT attempt (persisted
    -- before sending, so concurrent prepares never double-send); they may be
    -- replaced by a retry only while the account is not yet observed on
    -- chain. initialized_at is set once the account is observed, after which
    -- init_signature is frozen.
    init_signature              text,
    init_sent_at                timestamptz,
    initialized_at              timestamptz,
    check ((init_signature is null) = (init_sent_at is null)),
    check (initialized_at is null or init_signature is not null),

    created_by                  uuid not null references "user"(id),
    created_at                  timestamptz not null default now(),
    funded_at                   timestamptz,
    check ((status = 'FUNDED') = (funded_at is not null)),

    -- Last successful chain verification (finalized only).
    verified_at                 timestamptz,
    last_verified_slot          bigint,
    last_verified_commitment    text check (last_verified_commitment = 'finalized'),
    check ((verified_at is null) = (last_verified_slot is null)
        and (verified_at is null) = (last_verified_commitment is null)),

    version                     integer not null default 1,

    -- At most one funding account per task / per budget authorization, and a
    -- binding hash / PDA can never be shared.
    constraint project_funding_accounts_one_per_task unique (task_id),
    constraint project_funding_accounts_one_per_authorization unique (budget_authorization_id),
    constraint project_funding_accounts_binding_hash_unique unique (binding_hash),
    constraint project_funding_accounts_onchain_account_unique unique (onchain_account)
);

create index on project_funding_accounts (organization_id);

-- Identity/provenance/requirement columns and a bound customer wallet are
-- immutable once written, no matter which code path updates the row.
create function project_funding_accounts_guard() returns trigger as $$
begin
    if new.id <> old.id
        or new.organization_id <> old.organization_id
        or new.project_id <> old.project_id
        or new.task_id <> old.task_id
        or new.budget_authorization_id <> old.budget_authorization_id
        or new.network <> old.network
        or new.rpc_provider <> old.rpc_provider
        or new.asset_type <> old.asset_type
        or new.program_id <> old.program_id
        or new.onchain_account <> old.onchain_account
        or new.binding_hash <> old.binding_hash
        or new.requirement_source <> old.requirement_source
        or new.required_amount_base_units <> old.required_amount_base_units
        or new.created_by <> old.created_by
        or new.created_at <> old.created_at then
        raise exception 'project_funding_accounts: identity/provenance/requirement columns are immutable';
    end if;
    if old.customer_wallet is not null and new.customer_wallet is distinct from old.customer_wallet then
        raise exception 'project_funding_accounts: customer_wallet is immutable once bound';
    end if;
    if old.initialized_at is not null and new.init_signature is distinct from old.init_signature then
        raise exception 'project_funding_accounts: init_signature is immutable once initialized';
    end if;
    if new.confirmed_amount_base_units < old.confirmed_amount_base_units then
        raise exception 'project_funding_accounts: confirmed amount can never decrease in Phase 4E.1';
    end if;
    return new;
end;
$$ language plpgsql;

create trigger project_funding_accounts_immutable
    before update on project_funding_accounts
    for each row execute function project_funding_accounts_guard();

-- One row per verified, finalized deposit_project_funding instruction.
-- Phase 4E.1 accepts EXACTLY ONE deposit instruction per transaction, so a
-- transaction signature is the deposit's identity: UNIQUE(signature) makes
-- re-verification of the same signature unable to double-credit.
create table project_funding_deposits (
    id                          uuid primary key default gen_random_uuid(),
    funding_account_id          uuid not null references project_funding_accounts(id),
    signature                   text not null,
    amount_base_units           bigint not null check (amount_base_units > 0),
    depositor_wallet            text not null,
    slot                        bigint not null check (slot >= 0),
    block_time                  timestamptz,
    commitment                  text not null check (commitment = 'finalized'),
    verified_at                 timestamptz not null default now(),
    created_at                  timestamptz not null default now(),
    constraint project_funding_deposits_signature_unique unique (signature)
);

create index on project_funding_deposits (funding_account_id);

-- Verified deposits are an append-only ledger.
create function project_funding_deposits_append_only() returns trigger as $$
begin
    raise exception 'project_funding_deposits is append-only';
end;
$$ language plpgsql;

create trigger project_funding_deposits_no_update
    before update or delete on project_funding_deposits
    for each row execute function project_funding_deposits_append_only();
