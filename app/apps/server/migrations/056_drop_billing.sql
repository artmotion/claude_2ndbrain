-- Billing removed from this fork.
--
-- 2ndBrain has no hosted service: every server is a self-host and behaves as
-- the old "billing disabled" deployment (no plans, no limits, nothing gated on
-- a subscription). The code that read and wrote these tables is gone, so the
-- tables go too. Earlier migrations (010, 024, 031, 051, 052, 054, 055) are
-- left untouched because they may already be applied; this one undoes them.
--
-- Order: `subscriptions` first (it references `billing_accounts`; its
-- `subscriptions_fill_id` trigger from 052 goes with it), then the join table, then the
-- accounts (`billing_accounts.owner_user_id` → "user" ON DELETE RESTRICT, which
-- would otherwise block deleting a user). Nothing else references these tables:
-- no view, no trigger on another table and no foreign key from outside the set.
-- Every statement is guarded, so this is safe on a database where any of them
-- never existed or was already dropped.

DROP TABLE IF EXISTS subscriptions;
DROP FUNCTION IF EXISTS subscriptions_fill_id();
DROP TABLE IF EXISTS billing_events;
DROP TABLE IF EXISTS billing_account_orgs;
DROP TABLE IF EXISTS billing_accounts;
DROP TABLE IF EXISTS account_entitlements;
