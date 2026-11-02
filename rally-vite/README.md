# React + TypeScript + Vite

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

Apply `supabase/migrations/20261101002000_player_age_gender_matching.sql` in Supabase after the earlier migrations. Signup collects an age group and gender; player profiles show those details to other players. Games are visible and joinable only by players whose age-group selection matches exactly and whose gender matches the game eligibility, unless the game is open to all genders. Players who select “Prefer not to say” can see all-gender games.

Apply `supabase/migrations/20261101003000_game_venue_type.sql` after that migration to add explicit venue types to games. Hosts choose a venue type when creating a game; players can filter by school, community park, sports centre, public outdoor court, indoor gym, community centre, or other. Existing games are backfilled from their venue text where possible.

Apply `supabase/migrations/20261102001000_game_join_approval.sql` after the venue-type migration to enable persistent join settings. Hosts can choose instant joining or require approval; requests are saved in Supabase, and hosts can approve or decline them from the game details. Existing games retain instant joining.

Apply `supabase/migrations/20261102002000_profile_matching_admin_access.sql` after the game invites/chat and invite-only-games migrations if profile age/gender columns are missing or Supabase reports a profile schema-cache error. It also creates a protected admin role and grants it to the Supabase Auth user UUID configured in that migration. Admins can view all published games across visibility, age, gender, and capacity filters; normal player join eligibility is unchanged. Refresh the app after applying the migration so PostgREST reloads its schema.
