begin;

alter table public.games
  add column if not exists visibility text not null default 'public';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.games'::regclass
      and conname = 'games_visibility_check'
  ) then
    alter table public.games
      add constraint games_visibility_check
      check (visibility in ('public', 'friends'));
  end if;
end
$$;

create or replace function public.is_rally_friend(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.rally_friendships friendship
    where friendship.status = 'accepted'
      and (
        (friendship.user_low = auth.uid() and friendship.user_high = p_user_id)
        or (friendship.user_high = auth.uid() and friendship.user_low = p_user_id)
      )
  );
$$;

revoke all on function public.is_rally_friend(uuid) from public;
grant execute on function public.is_rally_friend(uuid) to anon, authenticated;

drop policy if exists "RALLY public or friends game visibility" on public.games;
create policy "RALLY public or friends game visibility"
  on public.games
  as restrictive
  for select
  to anon, authenticated
  using (
    status = 'published'
    and (
      visibility = 'public'
      or host_id = auth.uid()
      or public.is_rally_friend(host_id)
    )
  );

drop policy if exists "RALLY visible games can be read" on public.games;
create policy "RALLY visible games can be read"
  on public.games
  for select
  to anon, authenticated
  using (
    status = 'published'
    and (
      visibility = 'public'
      or host_id = auth.uid()
      or public.is_rally_friend(host_id)
    )
  );

do $$
begin
  if to_regclass('public.game_participants') is null then
    raise exception 'Expected public.game_participants for the existing join_game RPC; no friends-only join guard was installed.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'game_participants'
      and column_name in ('game_id', 'rally_game_id')
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'game_participants'
      and column_name in ('user_id', 'player_id', 'profile_id')
  ) then
    raise exception 'Could not identify game and user columns in public.game_participants; no friends-only join guard was installed.';
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
begin
  if game_id_text is null or member_id_text is null then
    raise exception 'Could not verify the game participant. Contact RALLY support.';
  end if;

  if actor_id is null or member_id_text::uuid <> actor_id then
    raise exception 'You can only join a game as your signed-in account.';
  end if;

  select game.host_id, game.visibility
    into host_id, game_visibility
  from public.games game
  where game.id::text = game_id_text;

  if not found then
    raise exception 'This game no longer exists.';
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

drop trigger if exists enforce_friends_only_game_join on public.game_participants;
create trigger enforce_friends_only_game_join
  before insert or update on public.game_participants
  for each row
  execute function public.enforce_friends_only_game_join();

revoke all on function public.enforce_friends_only_game_join() from public, anon, authenticated;

commit;
