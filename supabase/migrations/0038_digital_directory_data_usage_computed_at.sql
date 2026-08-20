-- Tracks when the network-counter delta was last folded into data_used_mb_period/last_24h, so the
-- check-in itself can run every 6 hours (for fresher online/offline status and general metadata)
-- while the DU-style data-usage figure only actually gets recomputed roughly once a day, gated by
-- this timestamp rather than by the check-in cadence itself.
alter table public.workspace_devices add column if not exists data_usage_computed_at timestamptz;
