-- Traffic Sheet Venue Aliases (Settings > Integrations) need to be readable by any active user
-- viewing Traffic Sheet, not just admins - the whole point is fixing what regular team members
-- see in the Summary table/exports, not just what an admin sees. app_settings' existing RLS
-- (app_settings_admin_all, cmd ALL) restricts every operation - including SELECT - to is_admin(),
-- which would otherwise make mergeVenueName()'s client-side getSetting('venueAliases') call
-- silently return nothing for a non-admin team member (RLS just filters the row out, no error).
-- Adds one narrow, additional SELECT-only policy scoped to exactly that one settings key - every
-- other key (API keys/secrets among them) stays admin-only exactly as before; this doesn't touch
-- writes at all, which remain covered by the existing admin-only ALL policy.
create policy app_settings_venue_aliases_read
  on public.app_settings for select
  using (key = 'venueAliases' and public.is_active_user());
