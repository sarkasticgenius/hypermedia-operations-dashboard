-- Public bucket for re-hosted brand logo images (see brandfetch-lookup edge function). Logos were
-- previously just a live URL to Google's favicon service, re-fetched by the browser on every page
-- render - this bucket lets the edge function download the image once and serve it from our own
-- Storage/CDN from then on. Public (no RLS policy needed for reads - Supabase serves public-bucket
-- objects directly); only the edge function's service-role key ever writes to it, which bypasses
-- RLS entirely regardless.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'brand-logos',
  'brand-logos',
  true,
  204800,
  array['image/png', 'image/jpeg', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/gif', 'image/webp', 'image/svg+xml']
)
on conflict (id) do nothing;
