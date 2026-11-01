begin;

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

revoke all on function public.confirm_rally_game_completed(text) from public, anon;
grant execute on function public.confirm_rally_game_completed(text) to authenticated;

commit;
