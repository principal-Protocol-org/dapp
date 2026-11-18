-- Principal dApp, schema 0004: the event indexer, the oracle keeper's ticks, the monitoring alerts.
-- Amounts are numeric (exact, no float): token amounts in their 7-decimal base units.

create table if not exists events (
  id           text        primary key, -- the RPC event id
  network      text        not null,
  contract_id  text        not null,
  group_name   text        not null,
  topic        text        not null,
  ledger       integer     not null,
  close_time   timestamptz not null,
  tx_hash      text        not null,
  pool         text,
  data         jsonb       not null,
  raw_xdr      text        not null
);

create index if not exists events_network_group_ledger on events (network, group_name, ledger desc);
create index if not exists events_pool_ledger on events (pool, ledger desc);

create table if not exists oracle_ticks (
  id        bigserial   primary key,
  at        timestamptz not null default now(),
  network   text        not null,
  oracle    text        not null,
  mode      text        not null check (mode in ('push', 'feed')),
  decision  text        not null check (decision in ('pushed', 'synced', 'skipped', 'rejected', 'error')),
  value     numeric,
  reason    text,
  tx_hash   text,
  signer    text
);

create table if not exists alerts (
  id          bigserial   primary key,
  network     text        not null,
  kind        text        not null,
  subject     text        not null,
  severity    text        not null check (severity in ('warning', 'critical')),
  opened_at   timestamptz not null,
  resolved_at timestamptz,
  payload     jsonb       not null,
  test        boolean     not null default false
);

-- One open alert per (network, kind, subject): a repeat updates it, a resolve closes it.
create unique index if not exists alerts_open_unique on alerts (network, kind, subject) where resolved_at is null;
