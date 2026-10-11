-- ADR-0018: remember which plan (estimate lineage) a discussion was turned
-- into, so the Builds page only offers discussions that are still unplanned.
alter table discussion_conversations add column planned_lineage_id uuid;
