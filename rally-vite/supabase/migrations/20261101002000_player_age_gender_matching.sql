begin;

alter table public.profiles
  add column if not exists age_group text,
  add column if not exists gender text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_age_group_check'
  ) then
    alter table public.profiles
      add constraint profiles_age_group_check
      check (age_group is null or age_group in ('13–15', '15–17', '13–18', '17–19'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_gender_check'
  ) then
    alter table public.profiles
      add constraint profiles_gender_check
      check (gender is null or gender in ('girl', 'boy', 'prefer_not_to_say'));
  end if;
end
$$;

alter table public.games
  add column if not exists gender_eligibility text not null default 'all';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.games'::regclass
      and conname = 'games_gender_eligibility_check'
  ) then
    alter table public.games
      add constraint games_gender_eligibility_check
      check (gender_eligibility in ('all', 'girl', 'boy'));
  end if;
end
$$;

create or replace function public.enforce_friends_only_game_join()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  participant jsonb := to_jsonb(new);
  game_id_text text := coalesce(participant ->> 'game_id', participant ->> 'rally_game_id');
  member_id_text text := coalesce(
    participant ->> 'user_id',
    participant ->> 'player_id',
    participant ->> 'profile_id'
  );
  actor_id uuid := auth.uid();
  host_id uuid;
  game_visibility text;
  game_age_group text;
  game_gender_eligibility text;
  player_age_group text;
  player_gender text;
begin
  if game_id_text is null or member_id_text is null then
    raise exception 'Could not verify the game participant. Contact RALLY support.';
  end if;

  if actor_id is null or member_id_text::uuid <> actor_id then
    raise exception 'You can only join a game as your signed-in account.';
  end if;

  select game.host_id, game.visibility, game.age_group, game.gender_eligibility
    into host_id, game_visibility, game_age_group, game_gender_eligibility
  from public.games game
  where game.id::text = game_id_text;

  if not found then
    raise exception 'This game no longer exists.';
  end if;

  select profile.age_group, profile.gender
    into player_age_group, player_gender
  from public.profiles profile
  where profile.id = actor_id;

  if player_age_group is null or player_gender is null then
    raise exception 'Complete your age and gender profile before joining games.';
  end if;

  if game_age_group is null or player_age_group <> game_age_group then
    raise exception 'This game is only available to its selected age group.';
  end if;

  if game_gender_eligibility <> 'all'
    and game_gender_eligibility <> player_gender
  then
    raise exception 'This game is only available to its selected gender.';
  end if;

  if game_visibility = 'friends'
    and host_id <> actor_id
    and not public.is_rally_friend(host_id)
  then
    raise exception 'This is a friends-only game. You must be an accepted friend of the host to join.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_friends_only_game_join() from public, anon, authenticated;

commit;
