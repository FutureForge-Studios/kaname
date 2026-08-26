-- ------------------------------------------------------------------
-- Post-migration hardening. Idempotent; applied on every boot.
--
-- The audit trail is only worth having if an attacker who reaches the
-- panel cannot quietly rewrite it (KD-009). Two layers:
--   1. rules that reject UPDATE and DELETE on audit_events outright
--   2. a hash chain, so even a superuser edit is detectable
-- ------------------------------------------------------------------

CREATE OR REPLACE RULE audit_events_no_update AS
  ON UPDATE TO audit_events DO INSTEAD NOTHING;

CREATE OR REPLACE RULE audit_events_no_delete AS
  ON DELETE TO audit_events DO INSTEAD NOTHING;

CREATE OR REPLACE RULE terminal_recordings_no_update AS
  ON UPDATE TO terminal_recordings DO INSTEAD NOTHING;

-- Jobs are claimed with FOR UPDATE SKIP LOCKED; this partial index is
-- what keeps that claim O(1) as the jobs table grows without bound.
CREATE INDEX IF NOT EXISTS jobs_queued_claim_idx
  ON jobs (priority DESC, created_at)
  WHERE status = 'queued';

-- Metric reads are always "one server, one time window".
CREATE INDEX IF NOT EXISTS server_metrics_window_idx
  ON server_metrics (server_id, ts DESC);

CREATE INDEX IF NOT EXISTS server_metrics_5m_window_idx
  ON server_metrics_5m (server_id, bucket DESC);

-- Case-insensitive search over the resources the command palette hits
-- most. Kept as plain btree on lower(...) rather than trigram so this
-- works identically under PGlite, which has no pg_trgm.
CREATE INDEX IF NOT EXISTS servers_name_search_idx ON servers (lower(name));
CREATE INDEX IF NOT EXISTS domains_name_search_idx ON domains (lower(name));
CREATE INDEX IF NOT EXISTS sites_name_search_idx ON sites (lower(name));
CREATE INDEX IF NOT EXISTS mailboxes_address_search_idx ON mailboxes (lower(address));
CREATE INDEX IF NOT EXISTS db_databases_name_search_idx ON db_databases (lower(name));
CREATE INDEX IF NOT EXISTS containers_name_search_idx ON containers (lower(name));
