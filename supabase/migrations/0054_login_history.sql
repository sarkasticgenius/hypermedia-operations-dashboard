-- Separate from audit_log (which tracks IN-APP actions by an already-identified session) - this
-- tracks the LOGIN EVENT itself: who signed in/out, from what IP, roughly where, and on what
-- browser/OS. Kept as its own table rather than new audit_log columns so the general action log
-- doesn't carry columns that are null on every row except Login/Logout, and so this can be queried
-- (e.g. "every login from this IP") without scanning unrelated action rows.
--
-- ip_address/location/user_agent are populated server-side by the record-login-event Edge
-- Function, which reads them from the request itself (the x-forwarded-for header, and an IP
-- geolocation lookup) rather than trusting anything the client claims about itself - a browser can
-- report device/OS via its own User-Agent string, but never its host machine's name (no browser API
-- exposes that, unlike the native WorkspaceDirectory agent which has real OS access), so there is
-- deliberately no "PC name" column here.
create table public.login_history (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  user_id uuid references public.profiles(id) on delete set null,
  username text,
  name text,
  event text not null check (event in ('login', 'logout')),
  ip_address text,
  location text,
  user_agent text
);

create index login_history_ts_idx on public.login_history (ts desc);
create index login_history_user_id_idx on public.login_history (user_id);

-- Admin-only read, same as audit_log - no client-side insert policy at all, since every row is
-- written by record-login-event using the service role key (which bypasses RLS entirely), never
-- directly from the browser.
alter table public.login_history enable row level security;
create policy "login_history_select_admin" on public.login_history for select using (public.is_admin());
