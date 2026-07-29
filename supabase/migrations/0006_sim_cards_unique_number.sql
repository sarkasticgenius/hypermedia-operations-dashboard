-- Superseded by 0007 (a plain unique index doesn't work as an upsert onConflict target the way
-- a table constraint does) - kept so migration history matches what was actually applied.
create unique index if not exists sim_cards_sim_number_key on public.sim_cards (sim_number) where sim_number is not null;
