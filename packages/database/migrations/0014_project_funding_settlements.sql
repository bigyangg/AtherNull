-- Phase 4E.2 — acceptance-triggered settlement and rejection/failure refund
-- of a ProjectFunding account (docs/adr/0014-devnet-settlement-and-refund.md).
--
-- One row per funding account, ever: the decision to settle or refund is
-- made exactly once (UNIQUE funding_account_id), and the on-chain
-- settle/refund instruction closes the account, so it cannot be paid out
-- twice either. The row tracks the authority-signed payout transaction from
-- "decided" (PENDING) through "sent" (SUBMITTED) to "finalized on chain"
-- (FINALIZED). Only FINALIZED lets the task reach SETTLED / REFUNDED.

create table project_funding_settlements (
    id                          uuid primary key default gen_random_uuid(),
    funding_account_id          uuid not null references project_funding_accounts(id),
    organization_id             uuid not null references "organization"(id),
    task_id                     uuid not null references tasks(id),

    kind                        text not null check (kind in ('SETTLE', 'REFUND')),

    -- Lamports. release goes to the provider recipient, refund back to the
    -- bound customer; together they are exactly the confirmed deposit.
    release_amount_base_units   bigint not null check (release_amount_base_units >= 0),
    refund_amount_base_units    bigint not null check (refund_amount_base_units >= 0),
    recipient_wallet            text,
    customer_wallet             text not null,
    check (
        (kind = 'SETTLE' and recipient_wallet is not null)
        or (kind = 'REFUND' and recipient_wallet is null and release_amount_base_units = 0)
    ),

    status                      text not null default 'PENDING'
        check (status in ('PENDING', 'SUBMITTED', 'FINALIZED')),
    -- Latest sent attempt. Persisted BEFORE sending (claim), replaced only by
    -- a retry after the previous attempt is known dead or its blockhash
    -- expired; frozen once FINALIZED.
    signature                   text,
    sent_at                     timestamptz,
    check ((signature is null) = (sent_at is null)),
    check (status = 'PENDING' or signature is not null),
    finalized_slot              bigint,
    finalized_at                timestamptz,
    check ((status = 'FINALIZED') = (finalized_at is not null)),
    check ((status = 'FINALIZED') = (finalized_slot is not null)),

    created_by                  uuid not null references "user"(id),
    created_at                  timestamptz not null default now(),

    constraint project_funding_settlements_one_per_account unique (funding_account_id),
    constraint project_funding_settlements_one_per_task unique (task_id),
    constraint project_funding_settlements_signature_unique unique (signature)
);

create index on project_funding_settlements (organization_id);

-- The decision and its amounts are immutable; a FINALIZED row is frozen.
create function project_funding_settlements_guard() returns trigger as $$
begin
    if new.id <> old.id
        or new.funding_account_id <> old.funding_account_id
        or new.organization_id <> old.organization_id
        or new.task_id <> old.task_id
        or new.kind <> old.kind
        or new.release_amount_base_units <> old.release_amount_base_units
        or new.refund_amount_base_units <> old.refund_amount_base_units
        or new.recipient_wallet is distinct from old.recipient_wallet
        or new.customer_wallet <> old.customer_wallet
        or new.created_by <> old.created_by
        or new.created_at <> old.created_at then
        raise exception 'project_funding_settlements: the settlement decision is immutable';
    end if;
    if old.status = 'FINALIZED' then
        raise exception 'project_funding_settlements: a finalized settlement is frozen';
    end if;
    return new;
end;
$$ language plpgsql;

create trigger project_funding_settlements_immutable
    before update on project_funding_settlements
    for each row execute function project_funding_settlements_guard();

create function project_funding_settlements_no_delete() returns trigger as $$
begin
    raise exception 'project_funding_settlements rows are never deleted';
end;
$$ language plpgsql;

create trigger project_funding_settlements_no_delete
    before delete on project_funding_settlements
    for each row execute function project_funding_settlements_no_delete();
