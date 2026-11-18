-- Principal dApp, schema 0007: webhook delivery of the monitoring alerts (spec 0004 D-20, Task 9).
-- Each alert row carries two notices, its opening and its close, each posted once to ALERT_WEBHOOK_URL:
-- opened_posted: the opening notice was delivered (a 2xx answer);
-- resolved_posted: the close notice was delivered (meaningful once resolved_at is set).
-- A notice that could not be delivered stays false and is sent again by the next alert check.
-- Rows written before this migration predate the webhook: they are marked delivered, so they are never
-- posted late; rows written from now on start undelivered.

alter table alerts add column if not exists opened_posted boolean not null default true;
alter table alerts add column if not exists resolved_posted boolean not null default true;
alter table alerts alter column opened_posted set default false;
alter table alerts alter column resolved_posted set default false;
