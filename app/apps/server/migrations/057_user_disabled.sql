-- Admin panel (2026-10-18): accounts are created and managed by the server
-- owner, never by self sign-up. A disabled account keeps its data and
-- memberships but cannot start a session (auth.ts databaseHooks.session).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ NULL;
