create table public.brand_logos (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  domain text,
  logo_url text,
  fetched_at timestamptz,
  error text
);

alter table public.brand_logos enable row level security;

create policy "brand_logos_select" on public.brand_logos
  for select using (auth.uid() is not null);

create policy "brand_logos_write" on public.brand_logos
  for all using (public.is_admin()) with check (public.is_admin());
