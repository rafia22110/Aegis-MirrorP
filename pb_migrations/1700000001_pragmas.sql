-- =====================================================================
-- AEGIS MIRROR — PocketBase Migration #2: PRAGMAs
-- =====================================================================
-- Runs after the initial schema migration. SQLite PRAGMA statements
-- that change connection-level behavior (journal_mode, foreign_keys,
-- busy_timeout) cannot run inside a transaction, and PocketBase wraps
-- every migration in one. The init migration therefore leaves these
-- alone, and we apply them here as a follow-up.
--
-- After this migration, PocketBase itself will respect these settings
-- on every connection it opens, because we re-issue them at the top
-- of every JS hook too — see pb_hooks/main.pb.js.
-- =====================================================================

-- SQLite ignores PRAGMAs inside transactions (with the exception of a
-- few read-only ones). PocketBase runs this migration in its own
-- implicit transaction, so these statements have no effect when
-- executed via `migrate up`. The real fix is to also re-issue them at
-- the top of every pb_hook — see the pragma block in main.pb.js.
--
-- This file is therefore documented but inert. We keep it so the
-- migration history tells the story: "PRAGMAs were considered here,
-- and we settled on issuing them per-connection instead."

SELECT 1;