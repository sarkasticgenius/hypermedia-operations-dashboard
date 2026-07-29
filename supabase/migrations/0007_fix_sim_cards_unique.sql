-- The partial unique index from 0006 can't be used as a plain ON CONFLICT (sim_number) target
-- by supabase-js's .upsert() - Postgres needs an unqualified unique constraint for that. NULLs
-- are still allowed to repeat under a standard UNIQUE constraint, so this loses nothing.
drop index if exists public.sim_cards_sim_number_key;
alter table public.sim_cards add constraint sim_cards_sim_number_key unique (sim_number);
