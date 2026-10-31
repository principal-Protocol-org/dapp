-- Principal dApp, schema 0002 (additive): the registry caches each market's record, so pages list
-- discovered and published markets from the database alone, without validating inline (R2-36).
alter table market_registry add column if not exists market jsonb;
