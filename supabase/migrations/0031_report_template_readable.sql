-- The Reporting workspace's campaign report (PDF/Excel download) pulls its branding text - company
-- name, tagline, contact/address lines - from app_settings.reportTemplate instead of hardcoding it
-- in pdfReport.js/excelExport.js, so an admin can update it (a new phone number, a tagline change)
-- without a code change. Same RLS gap as venueAliases (see 0029_venue_aliases_readable.sql):
-- app_settings' existing policy (app_settings_admin_all, cmd ALL) restricts SELECT to is_admin(),
-- which would make any non-admin's report download silently fall back to the hardcoded defaults
-- (RLS just filters the row out, no error) instead of picking up the admin's edits. Adds one
-- narrow, additional SELECT-only policy scoped to exactly that one key; writes stay admin-only via
-- the existing ALL policy.
create policy app_settings_report_template_read
  on public.app_settings for select
  using (key = 'reportTemplate' and public.is_active_user());
