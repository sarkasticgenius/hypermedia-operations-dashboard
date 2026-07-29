create extension if not exists pgcrypto;

-- ============================= REFERENCE DATA =============================
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  is_rental boolean not null default false
);

create table public.contractors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  emails text[] not null default '{}',
  phone text,
  notes text,
  created_at timestamptz not null default now()
);

create table public.networks (
  id uuid primary key default gen_random_uuid(),
  name text unique not null
);

-- ============================= AUTH / PERMISSIONS =============================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  role text not null default 'team' check (role in ('admin','team')),
  name text not null default '',
  title text not null default '',
  active boolean not null default true,
  google_email text,
  created_at timestamptz not null default now()
);

create table public.user_permissions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  area text not null check (area in ('assets','assetsInventory','orders','locations','campaigns','staticCampaigns','permits','metroPic','tickets','simCards','pdooh','dashboards')),
  can_view boolean not null default false,
  can_add boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  can_export boolean not null default false,
  primary key (user_id, area)
);

-- ============================= LOCATIONS =============================
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'Planned' check (type in ('Installed','Planned')),
  address text,
  emirate text,
  notes text,
  chain text,
  is_combined boolean not null default false,
  combined_members uuid[] not null default '{}',
  broadsign_healthy_count integer,
  broadsign_as_of text,
  manual_asset_inventory_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.location_sub_assets (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  name text not null,
  status text not null default 'Offline' check (status in ('Online','Offline')),
  notes text,
  source text
);

-- ============================= HARDWARE INVENTORY (assets) =============================
create table public.assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  unit_price numeric(12,2) not null default 0,
  stock_available integer not null default 0,
  stock_on_site integer not null default 0,
  serial_number text,
  warranty_expiry date,
  date_of_rent date,
  maintenance_location text,
  maintenance_contractor text,
  status text not null default 'Active' check (status in ('Active','Retired','Faulty')),
  notes text,
  source text,
  glpi_id text,
  created_at timestamptz not null default now()
);

create table public.asset_locations (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  location_name text not null,
  qty integer not null default 0
);

create table public.asset_assignments (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.assets(id) on delete set null,
  asset_name text,
  location_name text,
  qty integer,
  date date not null default current_date,
  deployed_by text,
  sub_asset text
);

-- ============================= ASSET INVENTORY (deployed screen network) =============================
create table public.asset_inventory (
  id uuid primary key default gen_random_uuid(),
  source_asset_id integer unique,
  name text not null,
  venue text,
  location text,
  category text,
  pdooh_ready boolean not null default false,
  format text,
  width numeric,
  height numeric,
  screens integer,
  faces integer,
  special_render text,
  anydesk_id text,
  teamviewer_id text,
  sensor_id text,
  lat text,
  lng text,
  multiplier text,
  position text,
  player_box_id text,
  ad_duration numeric,
  player_type text,
  managed_by_hm boolean not null default false,
  source_created_at timestamptz,
  source text,
  contractor_id uuid references public.contractors(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.asset_inventory_networks (
  asset_inventory_id uuid not null references public.asset_inventory(id) on delete cascade,
  network_id uuid not null references public.networks(id) on delete cascade,
  primary key (asset_inventory_id, network_id)
);

-- ============================= PROCUREMENT =============================
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.assets(id) on delete set null,
  asset_name text,
  qty integer not null default 1,
  order_date date not null default current_date,
  destination text,
  status text not null default 'Ordered' check (status in ('Ordered','In Transit','Delivered')),
  delivery_note_path text,
  delivery_note_filename text,
  delivery_note_uploaded_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================= PERMITS =============================
create table public.permits (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  type text,
  location text,
  issued_by text,
  issue_date date,
  expiry_date date,
  notes text,
  document_path text,
  document_filename text,
  created_at timestamptz not null default now()
);

-- ============================= METRO PIC =============================
create table public.metro_pics (
  id uuid primary key default gen_random_uuid(),
  station text not null,
  pic_name text,
  designation text,
  phone text,
  email text,
  validity_start date,
  validity_end date,
  eid_number text,
  eid_document_path text,
  eid_document_filename text,
  notes text,
  created_at timestamptz not null default now()
);

create table public.metro_pic_renewals (
  id uuid primary key default gen_random_uuid(),
  metro_pic_id uuid not null references public.metro_pics(id) on delete cascade,
  validity_start date,
  validity_end date,
  pic_name text,
  designation text,
  phone text,
  email text,
  eid_number text,
  eid_document_path text,
  eid_document_filename text,
  renewed_on date not null default current_date,
  renewed_by text,
  notes text
);

-- ============================= TICKETS =============================
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'Issue' check (type in ('Issue','Internal')),
  title text not null,
  location text,
  asset_id uuid references public.assets(id) on delete set null,
  asset_name text,
  asset_inv_id uuid references public.asset_inventory(id) on delete set null,
  asset_inv_label text,
  description text,
  status text not null default 'Open' check (status in ('Open','In Progress','Resolved','Closed')),
  priority text not null default 'Medium' check (priority in ('Low','Medium','High','Critical')),
  root_cause text,
  extra_emails text[] not null default '{}',
  photo_path text,
  reported_by text,
  date_reported date not null default current_date,
  date_closed date,
  source text,
  external_id text,
  closed_by_contractor text,
  closure_media text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- ============================= SIM CARDS =============================
create table public.sim_cards (
  id uuid primary key default gen_random_uuid(),
  sim_number text,
  iccid text,
  carrier text,
  data_plan text,
  billing_cost numeric(10,2),
  data_allocation_gb numeric,
  procured_date date,
  active_since date,
  notes text,
  status text not null default 'In Stock',
  deployed_location_id uuid references public.locations(id) on delete set null,
  deployed_location_name text,
  deployed_asset_inv_id uuid references public.asset_inventory(id) on delete set null,
  deployed_asset_inv_label text,
  deployed_date date,
  source_sheet text,
  has_mismatch boolean not null default false,
  mismatch_note text,
  created_at timestamptz not null default now()
);

-- ============================= CAMPAIGNS =============================
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client text,
  locations text,
  start_date date,
  end_date date,
  budget numeric(12,2),
  status text not null default 'Scheduled' check (status in ('Scheduled','Online','Offline','Ended')),
  last_checked timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table public.static_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client text,
  format text check (format in ('Billboard','Vinyl Wrap','Poster','Print','Other')),
  locations text,
  start_date date,
  end_date date,
  budget numeric(12,2),
  status text not null default 'Scheduled' check (status in ('Scheduled','Live','Ended','Paused')),
  last_checked timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table public.static_installations (
  id uuid primary key default gen_random_uuid(),
  static_campaign_id uuid not null references public.static_campaigns(id) on delete cascade,
  location text,
  print_house text,
  install_permit_expiry date,
  install_permit_path text,
  install_permit_filename text,
  road_closure_needed boolean not null default false,
  road_closure_permit_expiry date,
  road_closure_permit_path text,
  road_closure_permit_filename text,
  notes text
);

create table public.static_machines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text check (category in ('Boom Lift','Spider Lift','Other')),
  contractor_id uuid references public.contractors(id) on delete set null,
  status text not null default 'Available' check (status in ('Available','In Use','Maintenance','Retired')),
  notes text
);

create table public.static_bookings (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.static_machines(id) on delete cascade,
  campaign_id uuid references public.static_campaigns(id) on delete set null,
  installation_id uuid references public.static_installations(id) on delete set null,
  start_date date not null,
  end_date date not null,
  booked_by text,
  notes text
);

-- ============================= DASHBOARDS =============================
create table public.dashboard_sections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  locked boolean not null default false,
  lock_key text unique,
  nav_group text not null default 'dashboards' check (nav_group in ('dashboards','campaigns','pdooh')),
  sort_order integer not null default 0
);

create table public.dashboards (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.dashboard_sections(id) on delete cascade,
  name text not null,
  url text not null,
  sort_order integer not null default 0
);

-- ============================= AUDIT LOG =============================
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  user_id uuid references public.profiles(id) on delete set null,
  username text,
  name text,
  action text not null,
  detail text
);

-- ============================= APP SETTINGS (key/value) =============================
create table public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
