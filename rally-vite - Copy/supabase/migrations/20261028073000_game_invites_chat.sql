begin;

do $$
begin
  if to_regclass('public.game_participants') is null then
    raise exception 'Expected public.game_participants from the existing RALLY game setup.';
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
    raise exception 'Could not identify game and user columns in public.game_participants.';
  end if;
end
$$;

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

create table if not exists public.rally_game_invitations (
  invite_id uuid primary key default gen_random_uuid(),
  game_id text not null,
  host_id uuid not null references auth.users(id) on delete cascade,
  invitee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (game_id, invitee_id)
);

create index if not exists rally_game_invitations_inbox_idx
  on public.rally_game_invitations (invitee_id, status, created_at desc);

alter table public.rally_game_invitations enable row level security;
revoke all on table public.rally_game_invitations from public, anon, authenticated;

create or replace function public.send_rally_game_invite(
  p_game_id text,
  p_invitee_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  game_host_id uuid;
  capacity integer;
  occupied_count integer;
  pending_invites integer;
  new_invite_id uuid;
begin
  if actor_id is null then
    raise exception 'Sign in to invite a friend.';
  end if;
  if actor_id = p_invitee_id then
    raise exception 'You cannot invite yourself.';
  end if;

  select game.host_id, game.total_spots into game_host_id, capacity
  from public.games game
  where game.id::text = p_game_id
    and game.status::text = 'published'
    and game.starts_at > now();

  if not found then
    raise exception 'This game is no longer available for invitations.';
  end if;
  if game_host_id <> actor_id then
    raise exception 'Only the game host can invite friends.';
  end if;
  if not exists (
    select 1
    from public.rally_friendships friendship
    where friendship.status = 'accepted'
      and (
        (friendship.user_low = actor_id and friendship.user_high = p_invitee_id)
        or (friendship.user_high = actor_id and friendship.user_low = p_invitee_id)
      )
  ) then
    raise exception 'You can only invite accepted friends.';
  end if;
  if public.is_rally_game_participant(p_game_id, p_invitee_id) then
    raise exception 'This friend has already joined the game.';
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

  select count(*)::integer into pending_invites
  from public.rally_game_invitations invitation
  where invitation.game_id = p_game_id
    and invitation.status = 'pending'
    and invitation.invitee_id <> p_invitee_id;

  if coalesce(occupied_count, 0) + coalesce(pending_invites, 0) >= coalesce(capacity, 0) then
    raise exception 'There are no unreserved spots left to invite another friend.';
  end if;

  insert into public.rally_game_invitations as existing
    (game_id, host_id, invitee_id, status, created_at, responded_at)
  values (p_game_id, actor_id, p_invitee_id, 'pending', now(), null)
  on conflict (game_id, invitee_id) do update
    set host_id = excluded.host_id,
        status = 'pending',
        created_at = now(),
        responded_at = null
    where existing.status = 'declined'
  returning existing.invite_id into new_invite_id;

  if new_invite_id is null then
    select invitation.invite_id into new_invite_id
    from public.rally_game_invitations invitation
    where invitation.game_id = p_game_id
      and invitation.invitee_id = p_invitee_id;
  end if;

  return new_invite_id;
end;
$$;

create or replace function public.get_rally_game_invites(p_game_id text)
returns table (
  invite_id uuid,
  invitee_id uuid,
  display_name text,
  status text,
  created_at timestamptz
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
    raise exception 'Sign in to view game invitations.';
  end if;

  select game.host_id into game_host_id
  from public.games game
  where game.id::text = p_game_id;
  if not found then
    raise exception 'This game no longer exists.';
  end if;
  if actor_id <> game_host_id
    and not public.is_rally_game_participant(p_game_id, actor_id)
    and not exists (
      select 1 from public.rally_game_invitations invitation
      where invitation.game_id = p_game_id and invitation.invitee_id = actor_id
    )
  then
    raise exception 'Only the host, invited friends, and joined players can view invitations.';
  end if;

  return query
  select invitation.invite_id, invitation.invitee_id,
    coalesce(profile.display_name, 'RALLY player')::text,
    invitation.status, invitation.created_at
  from public.rally_game_invitations invitation
  left join public.profiles profile on profile.id = invitation.invitee_id
  where invitation.game_id = p_game_id
    and (actor_id = game_host_id or invitation.invitee_id = actor_id)
  order by invitation.created_at;
end;
$$;

create or replace function public.get_my_rally_game_invites()
returns table (
  invite_id uuid,
  game_id text,
  game_name text,
  starts_at timestamptz,
  venue text,
  host_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Sign in to view game invitations.';
  end if;

  return query
  select invitation.invite_id, invitation.game_id,
    game.name::text, game.starts_at, game.venue::text,
    coalesce(profile.display_name, 'RALLY player')::text
  from public.rally_game_invitations invitation
  join public.games game on game.id::text = invitation.game_id
  left join public.profiles profile on profile.id = invitation.host_id
  where invitation.invitee_id = actor_id
    and invitation.status = 'pending'
    and game.status::text = 'published'
  order by game.starts_at;
end;
$$;

create or replace function public.respond_rally_game_invite(
  p_invite_id uuid,
  p_accept boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  invitation public.rally_game_invitations%rowtype;
  game_arg_type text;
begin
  if actor_id is null then
    raise exception 'Sign in to respond to a game invitation.';
  end if;

  select * into invitation
  from public.rally_game_invitations
  where invite_id = p_invite_id
  for update;
  if not found or invitation.invitee_id <> actor_id then
    raise exception 'This invitation is not available to your account.';
  end if;
  if invitation.status <> 'pending' then
    raise exception 'This invitation has already been answered.';
  end if;

  if p_accept then
    if not exists (
      select 1 from public.games game
      where game.id::text = invitation.game_id
        and game.status::text = 'published'
        and game.starts_at > now()
    ) then
      raise exception 'This game is no longer available to join.';
    end if;
    if not exists (
      select 1
      from public.rally_friendships friendship
      where friendship.status = 'accepted'
        and (
          (friendship.user_low = invitation.host_id and friendship.user_high = actor_id)
          or (friendship.user_high = invitation.host_id and friendship.user_low = actor_id)
        )
    ) then
      raise exception 'You must still be an accepted friend of the host to accept this invitation.';
    end if;

    if not public.is_rally_game_participant(invitation.game_id, actor_id) then
      select argument_type::regtype::text
        into game_arg_type
      from (
        select proc.proargtypes[0] as argument_type
        from pg_proc proc
        join pg_namespace ns on ns.oid = proc.pronamespace
        where ns.nspname = 'public'
          and proc.proname = 'join_game'
          and proc.pronargs = 1
          and proc.proargnames[1] = 'p_game_id'
        order by case proc.proargtypes[0]
          when 'uuid'::regtype::oid then 0
          when 'text'::regtype::oid then 1
          else 2
        end
        limit 1
      ) rpc_signature;

      if game_arg_type is null then
        raise exception 'The existing join_game(p_game_id) RPC was not found. Cannot accept invite safely.';
      end if;

      execute format('select public.join_game($1::%s)', game_arg_type)
        using invitation.game_id;
      if not public.is_rally_game_participant(invitation.game_id, actor_id) then
        raise exception 'The game join did not complete, so this invitation remains pending.';
      end if;
    end if;

    update public.rally_game_invitations
    set status = 'accepted', responded_at = now()
    where invite_id = p_invite_id;
    return jsonb_build_object('accepted', true, 'joined', true, 'game_id', invitation.game_id);
  end if;

  update public.rally_game_invitations
  set status = 'declined', responded_at = now()
  where invite_id = p_invite_id;
  return jsonb_build_object('accepted', false, 'joined', false, 'game_id', invitation.game_id);
end;
$$;

create table if not exists public.rally_game_messages (
  message_id uuid primary key default gen_random_uuid(),
  game_id text not null,
  sender_id uuid not null references auth.users(id) on delete cascade,
  message text not null check (char_length(message) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists rally_game_messages_timeline_idx
  on public.rally_game_messages (game_id, created_at);

alter table public.rally_game_messages enable row level security;
revoke all on table public.rally_game_messages from public, anon, authenticated;

create or replace function public.get_rally_game_messages(p_game_id text)
returns table (
  message_id uuid,
  sender_id uuid,
  sender_name text,
  message text,
  created_at timestamptz
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
    raise exception 'Sign in to view game chat.';
  end if;
  select game.host_id into game_host_id
  from public.games game
  where game.id::text = p_game_id;
  if not found then
    raise exception 'This game no longer exists.';
  end if;
  if actor_id <> game_host_id
    and not public.is_rally_game_participant(p_game_id, actor_id)
  then
    raise exception 'Only the host and joined players can view this chat.';
  end if;

  return query
  select chat.message_id, chat.sender_id,
    coalesce(profile.display_name, 'RALLY player')::text,
    chat.message, chat.created_at
  from public.rally_game_messages chat
  left join public.profiles profile on profile.id = chat.sender_id
  where chat.game_id = p_game_id
  order by chat.created_at;
end;
$$;

create or replace function public.send_rally_game_message(
  p_game_id text,
  p_message text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  new_message_id uuid;
  normalized_message text;
begin
  if actor_id is null then
    raise exception 'Sign in to send a game chat message.';
  end if;
  if p_message is null or char_length(btrim(p_message)) = 0 or char_length(p_message) > 500 then
    raise exception 'Messages must contain 1 to 500 characters.';
  end if;
  normalized_message := lower(translate(p_message, '@013457$!', 'aoieastsi'));
  normalized_message := regexp_replace(normalized_message, '[^a-z0-9]+', ' ', 'g');
  if normalized_message ~ '(^| )(ass|asshole|bastard|bitch|crap|damn|dick|fuck|hell|piss|shit|slut|whore)( |$)' then
    raise exception 'Please keep the game chat respectful. Profanity is not allowed.';
  end if;
  if not exists (
    select 1 from public.games game
    where game.id::text = p_game_id
      and (
        game.host_id = actor_id
        or public.is_rally_game_participant(p_game_id, actor_id)
      )
  ) then
    raise exception 'Only the host and joined players can send messages in this chat.';
  end if;

  insert into public.rally_game_messages (game_id, sender_id, message)
  values (p_game_id, actor_id, btrim(p_message))
  returning rally_game_messages.message_id into new_message_id;
  return new_message_id;
end;
$$;

revoke all on function public.send_rally_game_invite(text, uuid) from public, anon;
revoke all on function public.get_rally_game_invites(text) from public, anon;
revoke all on function public.get_my_rally_game_invites() from public, anon;
revoke all on function public.respond_rally_game_invite(uuid, boolean) from public, anon;
revoke all on function public.get_rally_game_messages(text) from public, anon;
revoke all on function public.send_rally_game_message(text, text) from public, anon;
grant execute on function public.send_rally_game_invite(text, uuid) to authenticated;
grant execute on function public.get_rally_game_invites(text) to authenticated;
grant execute on function public.get_my_rally_game_invites() to authenticated;
grant execute on function public.respond_rally_game_invite(uuid, boolean) to authenticated;
grant execute on function public.get_rally_game_messages(text) to authenticated;
grant execute on function public.send_rally_game_message(text, text) to authenticated;

commit;
