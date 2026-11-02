begin;

alter table public.games
  add column if not exists join_mode text not null default 'open';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.games'::regclass
      and conname = 'games_join_mode_check'
  ) then
    alter table public.games
      add constraint games_join_mode_check
      check (join_mode in ('open', 'approval'));
  end if;
end
$$;

create table if not exists public.rally_game_join_requests (
  request_id uuid primary key default gen_random_uuid(),
  game_id text not null,
  player_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined')),
  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (game_id, player_id)
);

create index if not exists rally_game_join_requests_player_idx
  on public.rally_game_join_requests (player_id, status);

create index if not exists rally_game_join_requests_game_idx
  on public.rally_game_join_requests (game_id, status, requested_at);

alter table public.rally_game_join_requests enable row level security;
revoke all on table public.rally_game_join_requests from public, anon, authenticated;

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

create or replace function public.get_my_rally_game_join_requests()
returns table (game_id text, status text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select request.game_id, request.status
  from public.rally_game_join_requests request
  where request.player_id = auth.uid()
    and request.status = 'pending';
$$;

create or replace function public.get_rally_game_join_requests(p_game_id text)
returns table (
  request_id uuid,
  player_id uuid,
  display_name text,
  requested_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  game_host_id uuid;
begin
  if actor_id is null then
    raise exception 'Sign in to view game join requests.';
  end if;

  select game.host_id into game_host_id
  from public.games game
  where game.id::text = p_game_id
    and game.join_mode = 'approval';

  if not found then
    raise exception 'This approval-based game no longer exists.';
  end if;
  if actor_id <> game_host_id then
    raise exception 'Only the game host can view join requests.';
  end if;

  return query
  select request.request_id, request.player_id,
         coalesce(profile.display_name, 'RALLY player')::text,
         request.requested_at
  from public.rally_game_join_requests request
  left join public.profiles profile on profile.id = request.player_id
  where request.game_id = p_game_id
    and request.status = 'pending'
  order by request.requested_at;
end;
$$;

create or replace function public.respond_rally_game_join_request(
  p_request_id uuid,
  p_approve boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  join_request public.rally_game_join_requests%rowtype;
  game_host_id uuid;
  game_capacity integer;
  occupied_count integer;
  game_column text;
  player_column text;
  game_id_type text;
  player_id_type text;
begin
  if actor_id is null then
    raise exception 'Sign in to respond to game requests.';
  end if;
  if p_approve is null then
    raise exception 'Choose whether to approve or decline this request.';
  end if;

  select request.* into join_request
  from public.rally_game_join_requests request
  where request.request_id = p_request_id
  for update;
  if not found then
    raise exception 'This join request no longer exists.';
  end if;
  if join_request.status <> 'pending' then
    raise exception 'This join request has already been answered.';
  end if;

  select game.host_id, game.total_spots
    into game_host_id, game_capacity
  from public.games game
  where game.id::text = join_request.game_id
    and game.join_mode = 'approval'
    and game.status::text = 'published'
  for update;
  if not found then
    raise exception 'This game is no longer available.';
  end if;
  if actor_id <> game_host_id then
    raise exception 'Only the game host can respond to join requests.';
  end if;

  if not p_approve then
    update public.rally_game_join_requests
    set status = 'declined', responded_at = now()
    where request_id = p_request_id;
    return jsonb_build_object('approved', false, 'game_id', join_request.game_id);
  end if;

  if not public.is_rally_game_participant(join_request.game_id, join_request.player_id) then
    select count(distinct coalesce(
      to_jsonb(participant) ->> 'user_id',
      to_jsonb(participant) ->> 'player_id',
      to_jsonb(participant) ->> 'profile_id'
    ))::integer into occupied_count
    from public.game_participants participant
    where coalesce(
      to_jsonb(participant) ->> 'game_id',
      to_jsonb(participant) ->> 'rally_game_id'
    ) = join_request.game_id;

    if coalesce(occupied_count, 0) >= coalesce(game_capacity, 0) then
      raise exception 'There are no open spots left in this game.';
    end if;

    select column_name into game_column
    from unnest(array['game_id', 'rally_game_id']) with ordinality as candidate(column_name, ordinal)
    where exists (
      select 1 from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'game_participants'
        and column_info.column_name = candidate.column_name
    )
    order by ordinal
    limit 1;

    select column_name into player_column
    from unnest(array['user_id', 'player_id', 'profile_id']) with ordinality as candidate(column_name, ordinal)
    where exists (
      select 1 from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'game_participants'
        and column_info.column_name = candidate.column_name
    )
    order by ordinal
    limit 1;

    if game_column is null or player_column is null then
      raise exception 'Could not identify the game participant columns. Contact RALLY support.';
    end if;

    select format_type(attribute.atttypid, attribute.atttypmod)
      into game_id_type
    from pg_attribute attribute
    where attribute.attrelid = 'public.game_participants'::regclass
      and attribute.attname = game_column
      and not attribute.attisdropped;

    select format_type(attribute.atttypid, attribute.atttypmod)
      into player_id_type
    from pg_attribute attribute
    where attribute.attrelid = 'public.game_participants'::regclass
      and attribute.attname = player_column
      and not attribute.attisdropped;

    if game_id_type is null or player_id_type is null then
      raise exception 'Could not identify the game participant column types. Contact RALLY support.';
    end if;

    update public.rally_game_join_requests
    set status = 'accepted', responded_at = now()
    where request_id = p_request_id;

    execute format(
      'insert into public.game_participants (%I, %I) values ($1::%s, $2::%s) on conflict do nothing',
      game_column, player_column, game_id_type, player_id_type
    ) using join_request.game_id, join_request.player_id::text;

    if not public.is_rally_game_participant(join_request.game_id, join_request.player_id) then
      raise exception 'The player could not be added to this game.';
    end if;
  else
    update public.rally_game_join_requests
    set status = 'accepted', responded_at = now()
    where request_id = p_request_id;
  end if;

  return jsonb_build_object('approved', true, 'game_id', join_request.game_id);
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

  select profile.age_group, profile.gender
    into player_age_group, player_gender
  from public.profiles profile
  where profile.id = member_id;
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

drop trigger if exists enforce_friends_only_game_join on public.game_participants;
create trigger enforce_friends_only_game_join
  before insert or update on public.game_participants
  for each row
  execute function public.enforce_friends_only_game_join();

create or replace function public.reset_rally_join_request_after_leave()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  participant jsonb := to_jsonb(old);
  game_id_text text := coalesce(participant ->> 'game_id', participant ->> 'rally_game_id');
  member_id_text text := coalesce(
    participant ->> 'user_id',
    participant ->> 'player_id',
    participant ->> 'profile_id'
  );
begin
  if game_id_text is not null and member_id_text is not null then
    update public.rally_game_join_requests
    set status = 'declined', responded_at = now()
    where game_id = game_id_text
      and player_id = member_id_text::uuid
      and status = 'accepted';
  end if;
  return old;
end;
$$;

drop trigger if exists reset_rally_join_request_after_leave on public.game_participants;
create trigger reset_rally_join_request_after_leave
  after delete on public.game_participants
  for each row
  execute function public.reset_rally_join_request_after_leave();

revoke all on function public.request_rally_game_join(text) from public, anon;
revoke all on function public.get_my_rally_game_join_requests() from public, anon;
revoke all on function public.get_rally_game_join_requests(text) from public, anon;
revoke all on function public.respond_rally_game_join_request(uuid, boolean) from public, anon;
revoke all on function public.reset_rally_join_request_after_leave() from public, anon, authenticated;
grant execute on function public.request_rally_game_join(text) to authenticated;
grant execute on function public.get_my_rally_game_join_requests() to authenticated;
grant execute on function public.get_rally_game_join_requests(text) to authenticated;
grant execute on function public.respond_rally_game_join_request(uuid, boolean) to authenticated;
revoke all on function public.enforce_friends_only_game_join() from public, anon, authenticated;

commit;
