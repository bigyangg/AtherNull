-- Automatic fix rounds: when the independent verifier fails a build, the
-- build goes back to the agent once or twice with the verifier's findings
-- (routes/verification.ts) before it is declared failed. These rounds are
-- recorded as change requests with source 'verifier' and no requesting user;
-- only 'customer' rounds count against the customer's change-round cap.
alter table task_change_requests
    add column source text not null default 'customer' check (source in ('customer', 'verifier'));

alter table task_change_requests alter column requested_by drop not null;

alter table task_change_requests
    add constraint task_change_requests_requester check (source = 'verifier' or requested_by is not null);
