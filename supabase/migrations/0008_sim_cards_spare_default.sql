-- Real seeded data uses 'Spare' (the original app's actual terminology), not 'In Stock' - align
-- the column default so new rows created without an explicit status match the existing data.
alter table public.sim_cards alter column status set default 'Spare';
