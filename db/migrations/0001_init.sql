-- Principal dApp, schema 0001: market snapshots, the market registry cache, the indexer cursor.
-- Amounts are numeric (exact, no float): token amounts in their 7-decimal base units.

create table if not exists market_state_snapshots (
  pool         text        not null,
  slot         bigint      not null, -- floor(ledger close time / 900)
  ledger       bigint      not null,
  close_time   timestamptz not null,
  implied_rate numeric     not null,
  pt_price     numeric     not null,
  pt_reserve   numeric     not null,
  sy_reserve   numeric     not null,
  total_lp     numeric     not null,
  pt_supply    numeric     not null,
  yt_supply    numeric     not null,
  sy_rate      numeric     not null,
  oracle_rate  numeric     not null,
  oracle_ts    bigint      not null,
  fees_protocol numeric    not null,
  fees_creator numeric     not null,
  primary key (pool, slot)
);

create table if not exists market_registry (
  pool       text primary key,
  market_id  text,
  source     text check (source in ('seed', 'discovered', 'published')),
  valid      boolean,
  reason     text,
  updated_at timestamptz
);

create table if not exists ingest_cursor (
  name   text primary key,
  ledger bigint,
  cursor text
);
