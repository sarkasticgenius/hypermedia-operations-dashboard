# Hypermedia Operations Dashboard

A DOOH (digital out-of-home) operations dashboard: hardware inventory, the deployed
screen/player network, procurement, locations, permits, Metro PIC directory, tickets, SIM
cards, digital + static campaigns, a contractor ticket-closing portal, and Broadsign/Grassfish
integrations.

This is a rewrite of the original single-file `hypermedia-operations.html` app (which stored
everything in the browser's `localStorage`) as a proper [Vite](https://vitejs.dev) project backed
by [Supabase](https://supabase.com) — real Postgres tables, Row Level Security mirroring the
original's 12-area permission model, Supabase Auth, file uploads in Supabase Storage, and a
handful of Edge Functions for anything that needs a secret to stay server-side.

## Stack

- **Frontend**: vanilla JS + Vite, no framework. Pages are functions that return HTML strings
  (same pattern the original app used) with a lightweight `STATE`/`render()` loop in
  [`src/state.js`](src/state.js) — see that file's comments for how it works.
- **Backend**: Supabase (Postgres + Auth + Storage + Edge Functions).
- **CSV/Excel import-export**: [`xlsx`](https://www.npmjs.com/package/xlsx) (SheetJS).

## Project layout

```
index.html, src/main.js       entry point, wires every page + the global `App` click-handler object
src/state.js                  STATE, render loop, loadData()/invalidate() cache-and-refetch helper
src/auth.js                   Supabase Auth session handling, the 12-area/5-flag permission model
src/router.js, src/shell.js   page routing + permission gating, sidebar/topbar chrome
src/modals.js                 modal dispatcher (STATE.modal.type -> registered render function)
src/data/*.js                 one module per entity, wraps supabase-js CRUD calls
src/pages/*.js                one module per page (render function + its modal + handlers)
src/lib/*.js                  format helpers, audit log, Storage upload helpers, CSV import/export
supabase/migrations/*.sql     the full schema, RLS policies, triggers, reference-data seed
supabase/functions/*          Edge Functions (see below)
scripts/seed.mjs              loads the real operational data (see "Seeding real data")
scripts/extract-legacy-data.mjs  one-off script that pulled that data out of the legacy HTML file
```

## Getting started

```bash
npm install
cp .env.example .env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from your Supabase project's
# Project Settings -> API page
npm run dev
```

### Setting up a fresh Supabase project

1. Create a project at [supabase.com](https://supabase.com) (or use the Supabase MCP tools if
   you're doing this from an AI coding agent).
2. Apply the migrations in `supabase/migrations/` **in order** — either via the Supabase CLI
   (`supabase db push`, if you've linked the project), or by pasting each file's contents into
   the SQL Editor in the Supabase dashboard, in filename order (`0001_schema.sql` first).
3. Copy the project's `URL` and `anon`/`publishable` key into `.env`.
4. **Bootstrap the first admin account.** The `admin-create-user` Edge Function allows exactly
   one unauthenticated call: when `public.profiles` is empty, it creates whoever calls it as an
   admin. After that first call, every subsequent call requires an authenticated admin caller.
   Deploy the Edge Functions first (`supabase functions deploy admin-create-user` etc., or via
   the dashboard), then run:
   ```bash
   curl -X POST "https://<project-ref>.supabase.co/functions/v1/admin-create-user" \
     -H "Authorization: Bearer <anon-key>" -H "apikey: <anon-key>" \
     -H "Content-Type: application/json" \
     -d '{"email":"you@example.com","password":"choose-a-strong-temp-password","username":"admin","name":"Your Name","role":"admin"}'
   ```
   Then sign in with that email/password from the login screen and change the password from
   the Account page.
5. Create additional users from the app's Admin page (Users tab) — that also goes through
   `admin-create-user`, which is why an admin session is required after the bootstrap call.

### Edge Functions

| Function | Purpose |
|---|---|
| `admin-create-user` | Creates `auth.users` + `profiles` + `user_permissions` rows. The anon key alone can't call `auth.admin.createUser`; this holds that boundary with the service role key, gated to admins (or a one-time bootstrap on an empty project). |
| `broadsign-sync` | Server-side Broadsign `monitor_poll/v2` sync — the original app sent the Broadsign API key straight from the browser in a `Bearer` header; this keeps it server-side. Matches players to `asset_inventory.player_box_id`, rolls health counts up to `locations`. |
| `grassfish-sync` | Same idea for Grassfish's `locationlist/init` API (`X-ApiKey` header). |
| `close-ticket-portal` | Backs the no-login contractor ticket-closing portal. Public by necessity (no session exists), but scoped to look up/close exactly one ticket by id — no broader table access. |

Deploy with the Supabase CLI (`supabase functions deploy <name>`) or the dashboard. They read
`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`, which Supabase injects
automatically at runtime — you don't set those yourself.

### Seeding real data

The original file had two kinds of seed data baked in: generic demo/placeholder records (fake
assets, tickets, permits, contractors with `@example.com` emails) and real operational records
(the deployed screen inventory, SIM cards, venues with live Broadsign health counts, and BI
dashboard links). **Only the real data is seeded** — the demo records were sample data for a
fresh install and would just be clutter in a production database.

That real data is **not committed to this repo, ever, in any form** — no raw exports, no
counts, no identifiers. `scripts/seed-data/*.json` is gitignored on purpose: operational and
company data (asset/SIM/location details, contractor info, credentials, API details, or
anything else identifying the business) does not belong in a git history, public or private.
The live Supabase project already has it loaded (done once, locally, the same way — access to
that data is controlled entirely by Supabase Auth + the RLS policies in this repo, not by
keeping the repo private). To regenerate that folder and re-seed a different project:

```bash
node scripts/extract-legacy-data.mjs   # pulls the arrays out of the legacy HTML file - see its
                                        # header comment for SOURCE_HTML_PATH
# fill SUPABASE_SERVICE_ROLE_KEY + SUPABASE_URL in .env (Project Settings -> API -> service_role
# key - keep this secret, never commit it, never use it in browser code)
npm run seed
```

Safe to re-run — every insert is an upsert keyed on a natural id (`source_asset_id`,
`sim_number`, location name, dashboard-link name).

## Permission model

Same as the original: two roles (`admin`, `team`), and for `team` users a 5-flag
(`view`/`add`/`edit`/`delete`/`export`) permission row per area, for 12 areas (`assets`,
`assetsInventory`, `orders`, `locations`, `campaigns`, `staticCampaigns`, `permits`, `metroPic`,
`tickets`, `simCards`, `pdooh`, `dashboards`). Enforced in two places: the UI (`src/auth.js`
`canView`/`canAdd`/etc.) hides buttons/pages you can't use, and — the part that actually matters
for security — Postgres Row Level Security policies re-check the same rules on every query via
the `has_permission()` SQL function in `0002_rls.sql`. A deactivated user (`profiles.active =
false`) loses access even mid-session, both client-side and at the RLS layer.

## Known simplifications vs. the original

Ported everything, but a few things were deliberately simplified rather than 1:1 replicated —
flagged here so they're easy to find and extend later, not silently missing:

- **Broadsign folder-fallback venues**: the original's `refresh_broadsign_snapshot.py` had a
  hand-maintained alias/fallback table for a subset of venues with no Asset Inventory rows,
  matched by Broadsign's folder hierarchy instead of by asset link. `broadsign-sync` only
  implements the primary match (via `asset_inventory.player_box_id`); those venues won't get a
  live health count until that mapping is ported into the Edge Function (the mapping itself is
  business-specific, so it isn't included here — see the legacy script if you have it).
- **Static campaign installations**: the `static_installations` table (per-site print
  house/permit tracking for static/print campaigns) exists in the schema but doesn't have a UI
  yet — the Static Campaigns page covers campaigns, machines, and bookings.
- **Bulk CSV import** is wired up for Hardware Assets, Locations, Digital Campaigns, and
  Permits (`src/pages/bulkImport.js`). The original also supported it for Orders and Asset
  Inventory; the pattern is generic (`IMPORT_CONFIGS` in that file) so adding those is a config
  entry, not new plumbing.
- **`multiple_permissive_policies` advisory**: a few tables have both an area-specific policy
  and an admin-covering policy that overlap for the same command — a harmless Postgres
  performance nit (Supabase's advisor flags it), not a correctness issue.

## Deployment

`npm run build` produces a static `dist/` you can host anywhere (Cloudflare Pages/Workers,
Netlify, Vercel, GitHub Pages, etc.) — it's a pure client-side app talking to Supabase over
HTTPS, no server needed beyond Supabase itself. Set the same `VITE_SUPABASE_URL`/
`VITE_SUPABASE_ANON_KEY` as build-time environment variables on whatever host you use.

**GitHub Pages** (what `.github/workflows/deploy.yml` does): builds and deploys automatically on
every push to `main`, reading `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` from repo secrets
(Settings → Secrets and variables → Actions → New repository secret) rather than the workflow
file — not because the anon key is dangerous to expose (it isn't; it ships in the built bundle
either way, and access is enforced by RLS, not key secrecy), just to keep the repo itself free of
any embedded values. You also need Settings → Pages → Source set to **GitHub Actions**, and
`vite.config.js`'s `base` must match your repo name (`/<repo-name>/`) since GitHub Pages project
sites are served from a subpath, not the domain root.

Note: **GitHub Pages does not serve a public site from a private repository on the free plan** —
if you make the repo private, the Pages site goes down until you either make the repo public
again or upgrade to GitHub Pro/Team/Enterprise. This only affects the *code repository's*
visibility; it doesn't affect Supabase, which is a separate service with its own access control
(RLS) regardless of where the frontend is hosted.

The contractor ticket-closing portal is reached at `<your-domain>/?portal=close&ticket=<ticket-id>`
— no login required by design, so make sure that link is only ever shared with the intended
contractor (it's generated per-ticket, not a general-access URL).
