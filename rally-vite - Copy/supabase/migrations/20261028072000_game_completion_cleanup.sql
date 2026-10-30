begin;

create table if not exists public.rally_game_completion_confirmations (
  game_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  confirmed_at timestamptz not null default now(),
  primary key (game_id, user_id)
);

alter table public.rally_game_completion_confirmations enable row level security;
revoke all on table public.rally_game_completion_confirmations from public, anon, authenticated;

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

revoke all on function public.is_rally_game_participant(text, uuid) from public, anon, authenticated;

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
  required_count integer;
  confirmed_count integer;
  actor_confirmed boolean;
begin
  if actor_id is null then
    raise exception 'Sign in to check game completion.';
  end if;

  select game.host_id
    into game_host_id
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
    'completed', false
  );
end;
$$;

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

  if clock_timestamp() < game_starts_at then
    raise exception 'A game can only be marked completed after its scheduled start time.';
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

  if confirmed_count >= required_count then
    delete from public.games
    where id::text = p_game_id;

    delete from public.rally_game_completion_confirmations
    where game_id = p_game_id;

    return jsonb_build_object(
      'completed', true,
      'confirmed_count', confirmed_count,
      'required_count', required_count
    );
  end if;

  return jsonb_build_object(
    'completed', false,
    'you_confirmed', true,
    'confirmed_count', confirmed_count,
    'required_count', required_count
  );
end;
$$;

create or replace function public.delete_expired_rally_games()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer;
begin
  delete from public.rally_game_completion_confirmations confirmation
  where confirmation.game_id in (
    select game.id::text
    from public.games game
    where game.starts_at <= clock_timestamp() - interval '12 hours'
       or lower(game.status::text) = 'completed'
  );

  delete from public.games game
  where game.starts_at <= clock_timestamp() - interval '12 hours'
     or lower(game.status::text) = 'completed';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.get_game_completion_status(text) from public, anon;
grant execute on function public.get_game_completion_status(text) to authenticated;
revoke all on function public.confirm_rally_game_completed(text) from public, anon;
grant execute on function public.confirm_rally_game_completed(text) to authenticated;
revoke all on function public.delete_expired_rally_games() from public, anon, authenticated;

create extension if not exists pg_cron with schema extensions;

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

commit;
