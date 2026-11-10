begin;

create extension if not exists pg_cron;

create table if not exists public.rally_game_completion_confirmations (
  game_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  confirmed_at timestamptz not null default now(),
  primary key (game_id, user_id)
);

alter table public.rally_game_completion_confirmations enable row level security;
revoke all on table public.rally_game_completion_confirmations
  from public, anon, authenticated;

create index if not exists games_starts_at_expiry_idx
  on public.games (starts_at);

create or replace function public.is_rally_game_participant(
  p_game_id text,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.game_participants participant
    where coalesce(
      to_jsonb(participant) ->> 'game_id',
      to_jsonb(participant) ->> 'rally_game_id'
    ) = p_game_id
      and coalesce(
        to_jsonb(participant) ->> 'user_id',
        to_jsonb(participant) ->> 'player_id',
        to_jsonb(participant) ->> 'profile_id'
      ) = p_user_id::text
  );
$$;

revoke all on function public.is_rally_game_participant(text, uuid)
  from public, anon, authenticated;

create or replace function public.rally_game_confirmation_rate(p_game_id text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with attendees(user_id) as (
    select game.host_id
    from public.games game
    where game.id::text = p_game_id
    union
    select coalesce(
      to_jsonb(participant) ->> 'user_id',
      to_jsonb(participant) ->> 'player_id',
      to_jsonb(participant) ->> 'profile_id'
    )::uuid
    from public.game_participants participant
    where coalesce(
      to_jsonb(participant) ->> 'game_id',
      to_jsonb(participant) ->> 'rally_game_id'
    ) = p_game_id
      and coalesce(
        to_jsonb(participant) ->> 'user_id',
        to_jsonb(participant) ->> 'player_id',
        to_jsonb(participant) ->> 'profile_id'
      ) is not null
  ),
  totals as (
    select count(*)::integer as required_count,
      count(*) filter (
        where exists (
          select 1
          from public.rally_game_completion_confirmations confirmation
          where confirmation.game_id = p_game_id
            and confirmation.user_id = attendee.user_id
        )
      )::integer as confirmed_count
    from attendees attendee
  )
  select case
    when required_count = 0 then 0::numeric
    else confirmed_count::numeric / required_count
  end
  from totals;
$$;

revoke all on function public.rally_game_confirmation_rate(text)
  from public, anon, authenticated;

create or replace function public.can_view_rally_game_after_start(p_game_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_rally_admin()
    or exists (
      select 1
      from public.games game
      where game.id::text = p_game_id
        and auth.uid() is not null
        and game.starts_at <= now()
        and game.starts_at > now() - interval '24 hours'
        and (
          game.host_id = auth.uid()
          or public.is_rally_game_participant(p_game_id, auth.uid())
      )
    );
$$;

revoke all on function public.can_view_rally_game_after_start(text)
  from public;
grant execute on function public.can_view_rally_game_after_start(text)
  to anon, authenticated;

drop policy if exists "RALLY public or friends game visibility" on public.games;
create policy "RALLY public or friends game visibility"
  on public.games
  as restrictive
  for select
  to anon, authenticated
  using (
    status::text in ('published', 'completed')
    and (
      public.is_rally_admin()
      or (
        status::text = 'published'
        and (
          (
            starts_at > now()
            and (
              visibility = 'public'
              or host_id = auth.uid()
              or (
                visibility = 'friends'
                and public.is_rally_friend(host_id)
              )
              or (
                visibility = 'invitees'
                and public.can_access_invite_only_rally_game(id::text)
              )
            )
          )
          or public.can_view_rally_game_after_start(id::text)
        )
      )
    )
  );

drop policy if exists "RALLY visible games can be read" on public.games;
create policy "RALLY visible games can be read"
  on public.games
  for select
  to anon, authenticated
  using (
    status::text in ('published', 'completed')
    and (
      public.is_rally_admin()
      or (
        status::text = 'published'
        and (
          (
            starts_at > now()
            and (
              visibility = 'public'
              or host_id = auth.uid()
              or (
                visibility = 'friends'
                and public.is_rally_friend(host_id)
              )
              or (
                visibility = 'invitees'
                and public.can_access_invite_only_rally_game(id::text)
              )
            )
          )
          or public.can_view_rally_game_after_start(id::text)
        )
      )
    )
  );

create or replace function public.get_game_completion_status(p_game_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  game_host_id uuid;
  game_starts_at timestamptz;
  required_count integer;
  confirmed_count integer;
  actor_confirmed boolean;
begin
  if actor_id is null then
    raise exception 'Sign in to check game completion.';
  end if;

  select game.host_id, game.starts_at
    into game_host_id, game_starts_at
  from public.games game
  where game.id::text = p_game_id;

  if not found then
    raise exception 'This game no longer exists.';
  end if;

  if actor_id <> game_host_id
    and not public.is_rally_game_participant(p_game_id, actor_id)
  then
    raise exception 'Only the host and joined players can confirm this game.';
  end if;

  if clock_timestamp() >= game_starts_at + interval '24 hours' then
    raise exception 'Game confirmations are available for 24 hours after the scheduled start.';
  end if;

  select count(distinct attendee.user_id)::integer
    into required_count
  from (
    select game.host_id as user_id
    from public.games game
    where game.id::text = p_game_id
    union
    select coalesce(
      to_jsonb(participant) ->> 'user_id',
      to_jsonb(participant) ->> 'player_id',
      to_jsonb(participant) ->> 'profile_id'
    )::uuid as user_id
    from public.game_participants participant
    where coalesce(
      to_jsonb(participant) ->> 'game_id',
      to_jsonb(participant) ->> 'rally_game_id'
    ) = p_game_id
      and coalesce(
        to_jsonb(participant) ->> 'user_id',
        to_jsonb(participant) ->> 'player_id',
        to_jsonb(participant) ->> 'profile_id'
      ) is not null
  ) attendee;

  select count(*)::integer
    into confirmed_count
  from public.rally_game_completion_confirmations confirmation
  where confirmation.game_id = p_game_id;

  select exists (
    select 1
    from public.rally_game_completion_confirmations confirmation
    where confirmation.game_id = p_game_id
      and confirmation.user_id = actor_id
  ) into actor_confirmed;

  return jsonb_build_object(
    'eligible', true,
    'you_confirmed', actor_confirmed,
    'confirmed_count', confirmed_count,
    'required_count', required_count,
    'completed', confirmed_count >= required_count
  );
end;
$$;

revoke all on function public.get_game_completion_status(text)
  from public, anon;
grant execute on function public.get_game_completion_status(text)
  to authenticated;

create or replace function public.confirm_rally_game_completed(p_game_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  game_host_id uuid;
  game_starts_at timestamptz;
  required_count integer;
  confirmed_count integer;
begin
  if actor_id is null then
    raise exception 'Sign in to mark a game completed.';
  end if;

  select game.host_id, game.starts_at
    into game_host_id, game_starts_at
  from public.games game
  where game.id::text = p_game_id
  for update;

  if not found then
    raise exception 'This game no longer exists.';
  end if;

  if clock_timestamp() < game_starts_at + interval '20 minutes' then
    raise exception 'A game can only be marked completed 20 minutes after its scheduled start time.';
  end if;

  if clock_timestamp() >= game_starts_at + interval '24 hours' then
    raise exception 'Game confirmations are available for 24 hours after the scheduled start.';
  end if;

  if actor_id <> game_host_id
    and not public.is_rally_game_participant(p_game_id, actor_id)
  then
    raise exception 'Only the host and joined players can confirm this game.';
  end if;

  insert into public.rally_game_completion_confirmations (game_id, user_id)
  values (p_game_id, actor_id)
  on conflict (game_id, user_id) do nothing;

  select count(distinct attendee.user_id)::integer
    into required_count
  from (
    select game.host_id as user_id
    from public.games game
    where game.id::text = p_game_id
    union
    select coalesce(
      to_jsonb(participant) ->> 'user_id',
      to_jsonb(participant) ->> 'player_id',
      to_jsonb(participant) ->> 'profile_id'
    )::uuid as user_id
    from public.game_participants participant
    where coalesce(
      to_jsonb(participant) ->> 'game_id',
      to_jsonb(participant) ->> 'rally_game_id'
    ) = p_game_id
      and coalesce(
        to_jsonb(participant) ->> 'user_id',
        to_jsonb(participant) ->> 'player_id',
        to_jsonb(participant) ->> 'profile_id'
      ) is not null
  ) attendee;

  select count(*)::integer
    into confirmed_count
  from public.rally_game_completion_confirmations confirmation
  where confirmation.game_id = p_game_id;

  return jsonb_build_object(
    'completed', confirmed_count >= required_count,
    'you_confirmed', true,
    'confirmed_count', confirmed_count,
    'required_count', required_count
  );
end;
$$;

revoke all on function public.confirm_rally_game_completed(text)
  from public, anon;
grant execute on function public.confirm_rally_game_completed(text)
  to authenticated;

create or replace function public.delete_expired_rally_games()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer;
begin
  delete from public.games game
  where game.starts_at <= clock_timestamp() - interval '24 hours'
    and public.rally_game_confirmation_rate(game.id::text) < 0.6;

  get diagnostics deleted_count = row_count;

  delete from public.rally_game_completion_confirmations confirmation
  where not exists (
    select 1
    from public.games game
    where game.id::text = confirmation.game_id
  );

  return deleted_count;
end;
$$;

revoke all on function public.delete_expired_rally_games()
  from public, anon, authenticated;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'rally-delete-expired-games'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;

  perform cron.schedule(
    'rally-delete-expired-games',
    '*/10 * * * *',
    'select public.delete_expired_rally_games();'
  );
end
$$;

notify pgrst, 'reload schema';

commit;
