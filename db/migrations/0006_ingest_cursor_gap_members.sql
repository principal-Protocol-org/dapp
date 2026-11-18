-- Principal dApp, schema 0006: what an event indexer cursor covers (spec 0004 D-15).
-- gap_from, gap_to: ledgers the RPC no longer held when the cursor passed them (inclusive), so their
--   events may be missing; written by the same guarded upsert that moves the cursor, cleared only by
--   an import that fills them.
-- members: the contract ids the cursor has read through its ledger; any other contract of the group
--   is read from the deploy ledger until it catches up.
-- reconcile: the last RecoveryEscrow reconciliation (escrow cursors): { at, results }.
-- All nullable: the registry's cursor (markets:<router>) sets none of them.

alter table ingest_cursor add column if not exists gap_from bigint;
alter table ingest_cursor add column if not exists gap_to bigint;
alter table ingest_cursor add column if not exists members text[];
alter table ingest_cursor add column if not exists reconcile jsonb;
