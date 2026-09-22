-- Agent Server integration, step 1: give an execution a place to record which
-- OpenHands conversation it maps to. Deliberately a new column, not a
-- repurposing of the existing (unused) sandbox_id — sandbox_id was never
-- written to by anything (confirmed via grep) and isn't the same concept
-- (a container id vs. a conversation id the Agent Server assigns).
alter table executions
    add column conversation_id text;
