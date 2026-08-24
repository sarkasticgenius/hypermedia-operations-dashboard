-- du_scraped_at is only ever stamped when the scrape actually PARSED something (see
-- workspace-directory-checkin), which left the two failure modes indistinguishable from each other
-- and from a device that had simply never run the scrape yet: all three stored nothing but nulls,
-- so the dashboard showed "Not checked" forever. Confirmed live on DR2-FOODCOURT - checking in
-- normally every cycle since 20 Aug 2026, Chrome installed, and the 8 AM gate advances on every
-- ATTEMPT rather than on success, so it had been silently trying and getting nothing back daily
-- for four days with no server-side trace of any of it.
alter table public.workspace_devices
  -- When the agent last RAN a scrape, regardless of what came back. Reported from the agent's own
  -- local state file on every check-in rather than only on the cycle that fires the scrape, so the
  -- answer survives (and shows up on the very next check-in) instead of waiting for tomorrow's 8 AM.
  add column if not exists du_scrape_attempted_at timestamptz,
  -- What that attempt produced, as one of:
  --   ok        - figures parsed and stored in du_data_*/du_phone_number.
  --   nodata    - the page loaded and reported nothing for this connection. This is the normal,
  --               permanent answer for a PC on Wi-Fi/LAN (du identifies the subscriber from the
  --               connection itself, so there is nothing to report and never will be) and is what
  --               lets the Data Usage column say "Wi-Fi / LAN" rather than "Not checked" forever.
  --   nobrowser - no machine-wide Chrome/Edge to drive. A fault on the PC, NOT a fact about its
  --               connection, so it must not be labelled Wi-Fi/LAN.
  --   error     - the scrape threw. Also a fault, see du_scrape_note.
  -- Kept separate from du_scrape_note precisely so the dashboard branches on a fixed value instead
  -- of pattern-matching prose that gets reworded later.
  add column if not exists du_scrape_outcome text,
  -- Human-readable detail for the fault outcomes, shown in the Digital Directory so the reason is
  -- readable without remoting into the PC to open its agent log. Null when outcome is ok/nodata.
  add column if not exists du_scrape_note text;
