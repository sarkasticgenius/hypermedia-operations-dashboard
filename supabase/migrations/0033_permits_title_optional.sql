-- Title/Type are being removed from the Permits UI entirely (captured in Notes instead per the
-- user's own request) - title was `not null` from the original schema, which would reject any
-- insert once the app stops collecting it. Type was already nullable.
alter table public.permits alter column title drop not null;
