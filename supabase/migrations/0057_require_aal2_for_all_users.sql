-- Extends the aal2 requirement already applied to is_admin() (see require_aal2_for_admin) to the
-- other three gatekeeper functions - between all four, this covers every RLS policy in the app, so
-- this is the entire remaining enforcement surface for making two-factor mandatory for every
-- account, not just admin. Ships together with (right after) the client-side mandatory-setup gate
-- in main.js/account.js so nobody who hasn't enrolled yet just sees empty tables everywhere with
-- no explanation - their next login walks them through it first.
--
-- (auth.jwt()->>'aal') = 'aal2' is NULL, not true, for a session with no aal claim at all, which
-- fails the boolean AND the same as false - fails closed by default, not open.
create or replace function public.has_permission(p_area text, p_action text)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select
    case
      when public.is_admin() then true
      else exists (
        select 1
        from public.user_permissions up
        join public.profiles p on p.id = up.user_id
        where up.user_id = auth.uid()
          and p.active
          and (auth.jwt()->>'aal') = 'aal2'
          and up.area = p_area
          and (
            (p_action = 'view' and up.can_view) or
            (p_action = 'add' and up.can_add) or
            (p_action = 'edit' and up.can_edit) or
            (p_action = 'delete' and up.can_delete) or
            (p_action = 'export' and up.can_export)
          )
      )
    end
$function$;

create or replace function public.is_own_client(p_client_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.profiles where id = auth.uid() and client_id = p_client_id and active
  ) and (auth.jwt()->>'aal') = 'aal2'
$function$;

create or replace function public.is_active_user()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists(
    select 1 from public.profiles where id = auth.uid() and active
  ) and (auth.jwt()->>'aal') = 'aal2'
$function$;
