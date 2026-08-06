-- Optional comment a client can attach when approving a campaign - shown alongside the Slack
-- notification the Approve action already posts. No RLS policy change needed: the existing
-- campaign_approvals_client_approve UPDATE policy only constrains status/client_id/approved_by
-- (see migration 0027), not which other columns a permitted update may also change.
alter table public.campaign_approvals add column comment text;
