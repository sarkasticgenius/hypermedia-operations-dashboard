-- Makes two-factor authentication a hard backend requirement for admin-level access, not just the
-- login screen's own challenge (see gateOnMfaChallenge in src/auth.js) - the difference matters
-- because a client-side gate only stops the UI from showing the dashboard, it can't stop a direct
-- API call made with a password-only (aal1) token. has_permission() and every `is_admin() OR ...`
-- policy in the app already route through this one function, so this single change is the entire
-- enforcement surface for "admin" - team and client accounts are untouched, since has_permission's
-- own per-row check and is_own_client()/is_active_user() aren't modified.
--
-- Bootstrap-safe: profiles_select's `id = auth.uid()` branch never calls is_admin(), so a
-- password-verified-but-not-yet-challenged admin session can still read its own profile (enough
-- for the app shell to show the login challenge screen) without needing aal2 first.
--
-- (auth.jwt()->>'aal') = 'aal2' is NULL, not true, for a session with no aal claim at all (a token
-- issued before MFA existed on this project, or any non-request context) - NULL fails the boolean
-- AND below the same as false, so this fails closed by default rather than open.
create or replace function public.is_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists(
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active
  ) and (auth.jwt()->>'aal') = 'aal2'
$function$;
