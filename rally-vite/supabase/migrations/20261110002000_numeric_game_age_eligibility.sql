begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.rally_player_birth_dates (
  user_id uuid primary key references auth.users(id) on delete cascade,
  birth_date date not null,
  created_at timestamptz not null default now()
);

alter table private.rally_player_birth_dates enable row level security;
revoke all on table private.rally_player_birth_dates
  from public, anon, authenticated;

create table if not exists private.rally_unmapped_game_age_ranges (
  game_id text primary key,
  legacy_age_group text,
  observed_min_age smallint,
  observed_max_age smallint,
  recorded_at timestamptz not null default now()
);

revoke all on table private.rally_unmapped_game_age_ranges
  from public, anon, authenticated;

alter table public.games
  add column if not exists min_age smallint,
  add column if not exists max_age smallint;

update public.games
set min_age = case trim(age_group::text)
      when '13–15' then 13
      when '15–17' then 15
      when '13–18' then 13
      when '17–19' then 17
      else min_age
    end,
    max_age = case trim(age_group::text)
      when '13–15' then 15
      when '15–17' then 17
      when '13–18' then 18
      when '17–19' then 19
      else max_age
    end
where min_age is null
   or max_age is null
   or min_age not between 13 and 19
   or max_age not between 13 and 19
   or min_age > max_age;

insert into private.rally_unmapped_game_age_ranges (
  game_id,
  legacy_age_group,
  observed_min_age,
  observed_max_age
)
select game.id::text, game.age_group::text, game.min_age, game.max_age
from public.games game
where game.min_age is null
   or game.max_age is null
   or game.min_age not between 13 and 19
   or game.max_age not between 13 and 19
   or game.min_age > game.max_age
on conflict (game_id) do update
set legacy_age_group = excluded.legacy_age_group,
    observed_min_age = excluded.observed_min_age,
    observed_max_age = excluded.observed_max_age,
    recorded_at = now();

update public.games
set min_age = null,
    max_age = null
where min_age is null
   or max_age is null
   or min_age not between 13 and 19
   or max_age not between 13 and 19
   or min_age > max_age;

delete from private.rally_unmapped_game_age_ranges unmapped
where exists (
  select 1
  from public.games game
  where game.id::text = unmapped.game_id
    and game.min_age is not null
    and game.max_age is not null
    and game.min_age between 13 and 19
    and game.max_age between 13 and 19
    and game.min_age <= game.max_age
    and trim(coalesce(game.age_group::text, '')) in ('13–15', '15–17', '13–18', '17–19')
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.games'::regclass
      and conname = 'games_age_range_valid_check'
  ) then
    alter table public.games
      add constraint games_age_range_valid_check
      check (
        (min_age is null and max_age is null)
        or (
          min_age is not null
          and max_age is not null
          and min_age between 13 and 19
          and max_age between 13 and 19
          and min_age <= max_age
        )
      );
  end if;
end
$$;

create or replace function public.prevent_invalid_rally_game_age_range()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT'
    or new.min_age is distinct from old.min_age
    or new.max_age is distinct from old.max_age
  then
    if new.min_age is null or new.max_age is null
      or new.min_age not between 13 and 19
      or new.max_age not between 13 and 19
      or new.min_age > new.max_age
    then
      raise exception 'Choose a valid game age range from 13 to 19.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_invalid_rally_game_age_range on public.games;
create trigger prevent_invalid_rally_game_age_range
  before insert or update on public.games
  for each row
  execute function public.prevent_invalid_rally_game_age_range();

revoke all on function public.prevent_invalid_rally_game_age_range()
  from public, anon, authenticated;

create or replace function private.rally_age_on_date(
  p_birth_date date,
  p_as_of date
)
returns integer
language sql
immutable
strict
set search_path = pg_temp
as $$
  select extract(year from p_as_of)::integer
    - extract(year from p_birth_date)::integer
    - case
        when to_char(p_as_of, 'MMDD') < to_char(p_birth_date, 'MMDD')
        then 1
        else 0
      end;
$$;

revoke all on function private.rally_age_on_date(date, date)
  from public, anon, authenticated;

create or replace function public.get_my_rally_player_age()
returns integer
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select private.rally_age_on_date(birth_date, current_date)
  from private.rally_player_birth_dates
  where user_id = auth.uid();
$$;

create or replace function public.save_my_rally_player_birth_date(
  p_birth_date date
)
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  existing_birth_date date;
  player_age integer;
begin
  if actor_id is null then
    raise exception 'Sign in before saving your date of birth.';
  end if;
  if p_birth_date is null or p_birth_date > current_date then
    raise exception 'Enter a valid date of birth.';
  end if;

  player_age := private.rally_age_on_date(p_birth_date, current_date);
  if player_age not between 13 and 19 then
    raise exception 'RALLY currently supports players aged 13 to 19.';
  end if;

  select birth_date into existing_birth_date
  from private.rally_player_birth_dates
  where user_id = actor_id
  for update;

  if found then
    if existing_birth_date <> p_birth_date then
      raise exception 'Your date of birth has already been saved and cannot be changed.';
    end if;
    return player_age;
  end if;

  insert into private.rally_player_birth_dates (user_id, birth_date)
  values (actor_id, p_birth_date)
  on conflict (user_id) do nothing;

  select birth_date into existing_birth_date
  from private.rally_player_birth_dates
  where user_id = actor_id;

  if existing_birth_date <> p_birth_date then
    raise exception 'Your date of birth has already been saved and cannot be changed.';
  end if;

  return player_age;
end;
$$;

revoke all on function public.get_my_rally_player_age()
  from public, anon;
grant execute on function public.get_my_rally_player_age()
  to authenticated;
revoke all on function public.save_my_rally_player_birth_date(date)
  from public, anon;
grant execute on function public.save_my_rally_player_birth_date(date)
  to authenticated;

create or replace function public.rally_game_age_gender_eligible(
  p_game_id text,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.games game
    join public.profiles profile on profile.id = p_user_id
    left join private.rally_player_birth_dates birth
      on birth.user_id = profile.id
    where game.id::text = p_game_id
      and (
        coalesce(profile.is_admin, false)
        or (
          birth.birth_date is not null
          and profile.gender is not null
          and game.min_age is not null
          and game.max_age is not null
          and private.rally_age_on_date(birth.birth_date, current_date)
            between game.min_age and game.max_age
          and (
            game.gender_eligibility = 'all'
            or game.gender_eligibility = profile.gender
          )
        )
      )
  );
$$;

revoke all on function public.rally_game_age_gender_eligible(text, uuid)
  from public, anon, authenticated;

create or replace function public.can_discover_rally_game(p_game_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and public.rally_game_age_gender_eligible(p_game_id, auth.uid());
$$;

revoke all on function public.can_discover_rally_game(text) from public;
grant execute on function public.can_discover_rally_game(text)
  to anon, authenticated;

create or replace function public.request_rally_game_join(p_game_id text)
returns text
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  game_host_id uuid;
  game_visibility text;
  game_min_age smallint;
  game_max_age smallint;
  game_gender_eligibility text;
  game_join_mode text;
  game_capacity integer;
  game_status text;
  game_starts_at timestamptz;
  player_gender text;
  player_birth_date date;
  player_age integer;
  existing_status text;
  occupied_count integer;
begin
  if actor_id is null then
    raise exception 'Sign in to request to join a game.';
  end if;

  select game.host_id, game.visibility, game.min_age, game.max_age,
         game.gender_eligibility, game.join_mode, game.total_spots,
         game.status::text, game.starts_at
    into game_host_id, game_visibility, game_min_age, game_max_age,
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
    select profile.gender into player_gender
    from public.profiles profile
    where profile.id = actor_id;
    if player_gender is null then
      raise exception 'Complete your gender profile before joining games.';
    end if;

    select birth.birth_date into player_birth_date
    from private.rally_player_birth_dates birth
    where birth.user_id = actor_id;
    if player_birth_date is null then
      raise exception 'Add your private date of birth to your profile before joining games.';
    end if;
    if game_min_age is null or game_max_age is null then
      raise exception 'This game age range needs review before players can join.';
    end if;

    player_age := private.rally_age_on_date(player_birth_date, current_date);
    if player_age < game_min_age or player_age > game_max_age then
      raise exception 'Your age is outside this game’s permitted range.';
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
set search_path = public, private, pg_temp
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
  game_min_age smallint;
  game_max_age smallint;
  game_gender_eligibility text;
  game_join_mode text;
  player_gender text;
  player_birth_date date;
  player_age integer;
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

  select game.host_id, game.visibility, game.min_age, game.max_age,
         game.gender_eligibility, game.join_mode
    into host_id, game_visibility, game_min_age, game_max_age,
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

  select profile.gender, profile.is_admin
    into player_gender, member_is_admin
  from public.profiles profile
  where profile.id = member_id;

  if not coalesce(member_is_admin, false) then
    if player_gender is null then
      raise exception 'Complete your gender profile before joining games.';
    end if;

    select birth.birth_date into player_birth_date
    from private.rally_player_birth_dates birth
    where birth.user_id = member_id;
    if player_birth_date is null then
      raise exception 'Add your private date of birth to your profile before joining games.';
    end if;
    if game_min_age is null or game_max_age is null then
      raise exception 'This game age range needs review before players can join.';
    end if;

    player_age := private.rally_age_on_date(player_birth_date, current_date);
    if player_age < game_min_age or player_age > game_max_age then
      raise exception 'The player is outside this game’s permitted age range.';
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
revoke all on function public.enforce_friends_only_game_join()
  from public, anon, authenticated;

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
            and (
              host_id = auth.uid()
              or public.can_discover_rally_game(id::text)
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
            and (
              host_id = auth.uid()
              or public.can_discover_rally_game(id::text)
            )
          )
          or public.can_view_rally_game_after_start(id::text)
        )
      )
    )
  );

notify pgrst, 'reload schema';

commit;
