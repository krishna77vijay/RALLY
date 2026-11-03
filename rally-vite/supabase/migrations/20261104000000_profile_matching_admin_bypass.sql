begin;

create or replace function public.request_rally_game_join(p_game_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  game_host_id uuid;
  game_visibility text;
  game_age_group text;
  game_gender_eligibility text;
  game_join_mode text;
  game_capacity integer;
  game_status text;
  game_starts_at timestamptz;
  player_age_group text;
  player_gender text;
  existing_status text;
  occupied_count integer;
begin
  if actor_id is null then
    raise exception 'Sign in to request to join a game.';
  end if;

  select game.host_id, game.visibility, game.age_group,
         game.gender_eligibility, game.join_mode, game.total_spots,
         game.status::text, game.starts_at
    into game_host_id, game_visibility, game_age_group,
         game_gender_eligibility, game_join_mode, game_capacity,
         game_status, game_starts_at
  from public.games game
  where game.id::text = p_game_id
  for update;

  if not found or game_status <> 'published' or game_starts_at <= now() then
    raise exception 'This game is no longer available to join.';
  end if;
  if actor_id = game_host_id then
    raise exception 'You cannot request to join your own game.';
  end if;
  if game_join_mode <> 'approval' then
    raise exception 'This game allows players to join instantly.';
  end if;
  if public.is_rally_game_participant(p_game_id, actor_id) then
    raise exception 'You have already joined this game.';
  end if;

  if not public.is_rally_admin() then
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
  end if;

  if game_visibility = 'friends'
    and not exists (
      select 1
      from public.rally_friendships friendship
      where friendship.status = 'accepted'
        and (
          (friendship.user_low = game_host_id and friendship.user_high = actor_id)
          or (friendship.user_high = game_host_id and friendship.user_low = actor_id)
        )
    )
  then
    raise exception 'This is a friends-only game. You must be an accepted friend of the host to join.';
  end if;
  if game_visibility = 'invitees'
    and not exists (
      select 1
      from public.rally_game_invitations invitation
      where invitation.game_id = p_game_id
        and invitation.invitee_id = actor_id
        and invitation.status in ('pending', 'accepted')
    )
  then
    raise exception 'This game is invite-only. You need an active invitation from the host to join.';
  end if;

  select count(distinct coalesce(
    to_jsonb(participant) ->> 'user_id',
    to_jsonb(participant) ->> 'player_id',
    to_jsonb(participant) ->> 'profile_id'
  ))::integer into occupied_count
  from public.game_participants participant
  where coalesce(
    to_jsonb(participant) ->> 'game_id',
    to_jsonb(participant) ->> 'rally_game_id'
  ) = p_game_id;

  if coalesce(occupied_count, 0) >= coalesce(game_capacity, 0) then
    raise exception 'There are no open spots left in this game.';
  end if;

  select request.status into existing_status
  from public.rally_game_join_requests request
  where request.game_id = p_game_id
    and request.player_id = actor_id;

  if existing_status = 'pending' then
    return 'pending';
  end if;
  insert into public.rally_game_join_requests as existing
    (game_id, player_id, status, requested_at, responded_at)
  values (p_game_id, actor_id, 'pending', now(), null)
  on conflict (game_id, player_id) do update
    set status = 'pending',
        requested_at = now(),
        responded_at = null
    where existing.status in ('declined', 'accepted');

  return 'pending';
end;
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
  member_id uuid;
  host_id uuid;
  game_visibility text;
  game_age_group text;
  game_gender_eligibility text;
  game_join_mode text;
  player_age_group text;
  player_gender text;
  member_is_admin boolean := false;
  host_approval boolean := false;
begin
  if game_id_text is null or member_id_text is null then
    raise exception 'Could not verify the game participant. Contact RALLY support.';
  end if;
  if actor_id is null then
    raise exception 'Sign in before joining a game.';
  end if;

  member_id := member_id_text::uuid;

  select game.host_id, game.visibility, game.age_group,
         game.gender_eligibility, game.join_mode
    into host_id, game_visibility, game_age_group,
         game_gender_eligibility, game_join_mode
  from public.games game
  where game.id::text = game_id_text
    and game.status::text = 'published'
    and game.starts_at > now()
  for update;
  if not found then
    raise exception 'This game is no longer available to join.';
  end if;

  if actor_id = host_id and actor_id <> member_id then
    select exists (
      select 1
      from public.rally_game_join_requests request
      where request.game_id = game_id_text
        and request.player_id = member_id
        and request.status = 'accepted'
    ) into host_approval;
  end if;

  if actor_id <> member_id and not host_approval then
    raise exception 'You can only join a game as your signed-in account.';
  end if;
  if game_join_mode = 'approval'
    and actor_id = member_id
    and actor_id <> host_id
    and not exists (
      select 1
      from public.rally_game_join_requests request
      where request.game_id = game_id_text
        and request.player_id = member_id
        and request.status = 'accepted'
    )
    and not exists (
      select 1
      from public.rally_game_invitations invitation
      where invitation.game_id = game_id_text
        and invitation.invitee_id = member_id
        and invitation.status = 'pending'
    )
  then
    raise exception 'This game requires host approval. Send a join request first.';
  end if;

  select profile.age_group, profile.gender, profile.is_admin
    into player_age_group, player_gender, member_is_admin
  from public.profiles profile
  where profile.id = member_id;
  if not coalesce(member_is_admin, false) then
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
  end if;
  if game_visibility = 'friends'
    and host_id <> member_id
    and not exists (
      select 1
      from public.rally_friendships friendship
      where friendship.status = 'accepted'
        and (
          (friendship.user_low = host_id and friendship.user_high = member_id)
          or (friendship.user_high = host_id and friendship.user_low = member_id)
        )
    )
  then
    raise exception 'This is a friends-only game. You must be an accepted friend of the host to join.';
  end if;
  if game_visibility = 'invitees'
    and host_id <> member_id
    and not exists (
      select 1
      from public.rally_game_invitations invitation
      where invitation.game_id = game_id_text
        and invitation.invitee_id = member_id
        and invitation.status in ('pending', 'accepted')
    )
  then
    raise exception 'This game is invite-only. You need an active invitation from the host to join.';
  end if;

  return new;
end;
$$;

revoke all on function public.request_rally_game_join(text) from public, anon;
grant execute on function public.request_rally_game_join(text) to authenticated;
revoke all on function public.enforce_friends_only_game_join() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
