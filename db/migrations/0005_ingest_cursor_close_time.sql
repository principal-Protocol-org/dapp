-- Principal dApp, schema 0005: the close time of a cursor's ledger, for the event indexer's lag.
-- Nullable: the registry's cursor (markets:<router>) does not set it.

alter table ingest_cursor add column if not exists close_time timestamptz;
