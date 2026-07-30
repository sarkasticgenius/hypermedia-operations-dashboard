alter table public.assets drop constraint assets_status_check;

update public.assets set status = 'Spare' where status = 'Active';
update public.assets set status = 'Deployed' where stock_on_site > 0 and status <> 'Faulty';

alter table public.assets add constraint assets_status_check
  check (status = any (array['Spare','Deployed','Retired','Faulty']));
