# React + TypeScript + Vite

## Find games near me

Apply `supabase/migrations/20261111000000_nearby_game_coordinates.sql` after the existing game eligibility and visibility migrations. It adds nullable venue coordinates and an authenticated nearby-search RPC. The RPC runs as the caller, so existing RLS visibility, age/gender eligibility, and admin rules remain in force. It uses a bounding-box candidate query followed by Haversine distance filtering and only returns games with valid coordinates.

Set `VITE_GEOAPIFY_API_KEY` in the local Vite environment and the deployment environment, then restart/redeploy. This key is public in a browser app: restrict it in Geoapify to the exact production and development HTTP origins. Do not commit the key. GPS is requested only after an explicit button click. A player can opt in to saving a rounded approximate location in browser local storage on this device (scoped to their signed-in account); it is not saved to Supabase or included in analytics. If saved, it is used for the next sign-in's nearby search. Players without a saved location who have not joined a game see an optional nearby-search prompt after 2 minutes 30 seconds on Find a Game. The prompt never requests permission by itself.

When a host publishes a game, RALLY checks the venue with Geoapify and saves its coordinates only when the top match has at least 0.75 confidence and leads the next match by at least 0.1. If Geoapify cannot confidently identify one venue, the host can choose and confirm the correct result or correct the address and retry. Confirmed coordinates are cached for the unchanged venue during the session; changing the venue requires a new check. Existing games are not automatically geocoded: rows without coordinates remain visible in normal game discovery but are excluded from nearby results. To plan a safe manual backfill, first inspect `select id, venue from public.games where latitude is null or longitude is null;`; validate each complete public venue with its host and Geoapify before updating coordinates. Do not infer coordinates from incomplete venue text.

Nearby journey events are emitted as sanitized `rally:analytics` browser events and printed to the browser console for WK6 testing. Only method, radius, count, duration, outcome, and join mode are permitted event properties; exact coordinates and entered location text are never logged.

## Expired game cleanup

Apply `supabase/migrations/20261110001000_game_history_visibility_and_cleanup.sql` to the Supabase project. Admins can view past games; hosts and joined players can view them and confirm completion for 24 hours after the scheduled start. Every 10 minutes, the cleanup job deletes games older than 24 hours only when fewer than 60% of the host and joined players confirmed completion. Games meeting that threshold remain available to admins.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## RALLY age and gender matching

Apply `supabase/migrations/20261110002000_numeric_game_age_eligibility.sql` after all earlier RALLY migrations, including game invites, profile matching, and game-history migrations. It converts the known legacy game labels (`13–15`, `15–17`, `13–18`, `17–19`) to inclusive `min_age` / `max_age` values and stores unsupported or malformed ranges for review in `private.rally_unmapped_game_age_ranges` instead of guessing. Inspect that table in the Supabase SQL editor with `select * from private.rally_unmapped_game_age_ranges;`. Existing profiles keep their age-group data; each player must add a date of birth once before joining or discovering age-matched games. Birth dates are stored in the non-API-exposed `private.rally_player_birth_dates` table, are not displayed to other players, and cannot be changed through the app. Players aged 13–19 are supported. Admins retain the existing database-controlled age and gender bypass.

The app and database both enforce the same inclusive age-range and gender rules. Backend checks cover game discovery through RLS, approval requests, and direct participant inserts; admins remain exempt only when their protected `profiles.is_admin` flag is set.

Apply `supabase/migrations/20261101003000_game_venue_type.sql` after that migration to add explicit venue types to games. Hosts choose a venue type when creating a game; players can filter by school, community park, sports centre, public outdoor court, indoor gym, community centre, or other. Existing games are backfilled from their venue text where possible.

Apply `supabase/migrations/20261102001000_game_join_approval.sql` after the venue-type migration to enable persistent join settings. Hosts can choose instant joining or require approval; requests are saved in Supabase, and hosts can approve or decline them from the game details. Existing games retain instant joining.

Apply `supabase/migrations/20261102002000_profile_matching_admin_access.sql` after the game invites/chat and invite-only-games migrations if profile age/gender columns are missing or Supabase reports a profile schema-cache error. It also creates a protected admin role and grants it to the Supabase Auth user UUID configured in that migration. Admins can view all published games across visibility, age, gender, and capacity filters; normal player join eligibility is unchanged. Refresh the app after applying the migration so PostgREST reloads its schema.
