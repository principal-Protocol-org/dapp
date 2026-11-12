-- Principal dApp, schema 0003 (additive): the markets the MarketFactory started, by salt (spec 0002 §5
-- "Resuming"). The registry indexes the factory's mkt_tok, mkt_eng and mkt_new events, so a market
-- whose creation stopped part way is listed to resume from any browser. Where it stands is read from the
-- chain by the wizard, never from here: this is only the list of salts to look at.
create table if not exists market_salts (
  factory    text        not null,
  salt       text        not null, -- 32 bytes, lower-case hex
  phase      text        not null check (phase in ('tokens', 'engine', 'pool')),
  ledger     bigint      not null, -- of the furthest phase seen
  updated_at timestamptz not null,
  primary key (factory, salt)
);
