begin;

alter table public.games
  drop constraint if exists games_visibility_check;

alter table public.games
  add constraint games_visibility_check
  check (visibility in ('public', 'friends', 'invitees'));

create or replace function public.can_access_invite_only_rally_game(p_game_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and (
      public.is_rally_game_participant(p_game_id, auth.uid())
      or exists (
        select 1
        from public.rally_game_invitations invitation
        where invitation.game_id = p_game_id
          and invitation.invitee_id = auth.uid()
          and invitation.status in ('pending', 'accepted')
      )
    );
$$;

revoke all on function public.can_access_invite_only_rally_game(text) from public;
grant execute on function public.can_access_invite_only_rally_game(text) to anon, authenticated;

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
      or (
        visibility = 'friends'
        and public.is_rally_friend(host_id)
      )
      or (
        visibility = 'invitees'
        and public.can_access_invite_only_rally_game(id::text)
      )
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
      or (
        visibility = 'friends'
        and public.is_rally_friend(host_id)
      )
      or (
        visibility = 'invitees'
        and public.can_access_invite_only_rally_game(id::text)
      )
    )
  );

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

  if game_visibility = 'invitees'
    and host_id <> actor_id
    and not exists (
      select 1
      from public.rally_game_invitations invitation
      where invitation.game_id = game_id_text
        and invitation.invitee_id = actor_id
        and invitation.status in ('pending', 'accepted')
    )
  then
    raise exception 'This game is invite-only. You need an active invitation from the host to join.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_friends_only_game_join() from public, anon, authenticated;

commit;
