-- Lets a Digital Directory PC be cross-referenced with the SAME screen it drives in the
-- Broadsign/Grassfish Console: the collector script (see defaultCollectorScript() in
-- src/pages/settings.js) reads the local Broadsign player-id file / Grassfish local REST endpoint
-- the same way broadsign-sync/grassfish-sync themselves match by Asset Inventory's Player Box ID -
-- so a device row here can join against asset_inventory on these values to show "this PC drives
-- screen X at location Y", and the Broadsign/Grassfish Console can join the other way to offer an
-- AnyDesk/TeamViewer connect option for an offline screen's PC.
alter table public.workspace_devices
  add column broadsign_player_id text,
  add column grassfish_box_id text;
