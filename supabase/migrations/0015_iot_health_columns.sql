alter table public.locations add column if not exists iot_healthy_count integer;
alter table public.locations add column if not exists iot_as_of text;
