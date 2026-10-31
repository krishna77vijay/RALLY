begin;

create table if not exists public.rally_game_review_attendees (
  game_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (game_id, user_id)
);

alter table public.rally_game_review_attendees enable row level security;
revoke all on table public.rally_game_review_attendees from public, anon, authenticated;

create or replace function public.archive_rally_review_attendees()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  required_count integer;
  confirmed_count integer;
begin
  select count(distinct attendee.user_id)::integer
    into required_count
  from (
    select game.host_id as user_id
    from public.games game
    where game.id::text = new.game_id
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
    ) = new.game_id
      and coalesce(
        to_jsonb(participant) ->> 'user_id',
        to_jsonb(participant) ->> 'player_id',
        to_jsonb(participant) ->> 'profile_id'
      ) is not null
  ) attendee;

  select count(*)::integer
    into confirmed_count
  from public.rally_game_completion_confirmations confirmation
  where confirmation.game_id = new.game_id;

  if required_count > 0 and confirmed_count >= required_count then
    insert into public.rally_game_review_attendees (game_id, user_id)
    select new.game_id, attendee.user_id
    from (
      select game.host_id as user_id
      from public.games game
      where game.id::text = new.game_id
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
      ) = new.game_id
        and coalesce(
          to_jsonb(participant) ->> 'user_id',
          to_jsonb(participant) ->> 'player_id',
          to_jsonb(participant) ->> 'profile_id'
        ) is not null
    ) attendee
    on conflict (game_id, user_id) do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.archive_rally_review_attendees() from public, anon, authenticated;

drop trigger if exists archive_rally_review_attendees
  on public.rally_game_completion_confirmations;
create trigger archive_rally_review_attendees
  after insert on public.rally_game_completion_confirmations
  for each row
  execute function public.archive_rally_review_attendees();

create table if not exists public.rally_player_reviews (
  review_id uuid primary key default gen_random_uuid(),
  game_id text not null,
  reviewer_id uuid not null references auth.users(id) on delete cascade,
  reviewed_player_id uuid not null references auth.users(id) on delete cascade,
  skill_rating smallint not null check (skill_rating between 1 and 5),
  attitude_rating smallint not null check (attitude_rating between 1 and 5),
  sportsmanship_rating smallint not null check (sportsmanship_rating between 1 and 5),
  reliability_rating smallint not null check (reliability_rating between 1 and 5),
  felt_safe boolean not null,
  private_safety_note text check (
    private_safety_note is null
    or char_length(private_safety_note) <= 500
  ),
  created_at timestamptz not null default now(),
  constraint rally_player_reviews_not_self check (reviewer_id <> reviewed_player_id),
  constraint rally_player_reviews_one_per_pair unique (reviewer_id, reviewed_player_id)
);

create index if not exists rally_player_reviews_target_idx
  on public.rally_player_reviews (reviewed_player_id, created_at desc);

alter table public.rally_player_reviews enable row level security;
revoke all on table public.rally_player_reviews from public, anon, authenticated;
grant select on table public.rally_player_reviews to service_role;

comment on column public.rally_player_reviews.felt_safe is
  'Private response for safety moderation; never included in player-facing summaries.';
comment on column public.rally_player_reviews.private_safety_note is
  'Optional private safety context; accessible only to trusted server-side moderators.';

create or replace function public.get_rally_review_targets()
returns table (
  game_id text,
  game_completed_at timestamptz,
  player_id uuid,
  player_name text
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
    raise exception 'Sign in to review players.';
  end if;

  return query
  select eligible.game_id,
    eligible.completed_at,
    eligible.player_id,
    coalesce(profile.display_name, 'RALLY player')::text
  from (
    select distinct on (attendee.user_id)
      attendee.game_id,
      attendee.completed_at,
      attendee.user_id as player_id
    from public.rally_game_review_attendees own_game
    join public.rally_game_review_attendees attendee
      on attendee.game_id = own_game.game_id
    where own_game.user_id = actor_id
      and attendee.user_id <> actor_id
      and not exists (
        select 1
        from public.rally_player_reviews review
        where review.reviewer_id = actor_id
          and review.reviewed_player_id = attendee.user_id
      )
    order by attendee.user_id, attendee.completed_at desc, attendee.game_id desc
  ) eligible
  left join public.profiles profile on profile.id = eligible.player_id
  order by eligible.completed_at desc, eligible.player_id;
end;
$$;

create or replace function public.submit_rally_player_review(
  p_game_id text,
  p_reviewed_player_id uuid,
  p_skill_rating smallint,
  p_attitude_rating smallint,
  p_sportsmanship_rating smallint,
  p_reliability_rating smallint,
  p_felt_safe boolean,
  p_private_safety_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  new_review_id uuid;
begin
  if actor_id is null then
    raise exception 'Sign in to submit a player review.';
  end if;
  if actor_id = p_reviewed_player_id then
    raise exception 'You cannot review yourself.';
  end if;
  if p_skill_rating is null or p_skill_rating not between 1 and 5
    or p_attitude_rating is null or p_attitude_rating not between 1 and 5
    or p_sportsmanship_rating is null or p_sportsmanship_rating not between 1 and 5
    or p_reliability_rating is null or p_reliability_rating not between 1 and 5
  then
    raise exception 'Ratings must be between 1 and 5.';
  end if;
  if p_felt_safe is null then
    raise exception 'Please answer whether you felt safe.';
  end if;
  if p_private_safety_note is not null
    and char_length(p_private_safety_note) > 500
  then
    raise exception 'The private safety note cannot exceed 500 characters.';
  end if;
  if not exists (
    select 1
    from public.rally_game_review_attendees own_game
    join public.rally_game_review_attendees other_player
      on other_player.game_id = own_game.game_id
    where own_game.game_id = p_game_id
      and own_game.user_id = actor_id
      and other_player.user_id = p_reviewed_player_id
  ) then
    raise exception 'You can only review another player from a game you both completed.';
  end if;

  insert into public.rally_player_reviews (
    game_id,
    reviewer_id,
    reviewed_player_id,
    skill_rating,
    attitude_rating,
    sportsmanship_rating,
    reliability_rating,
    felt_safe,
    private_safety_note
  )
  values (
    p_game_id,
    actor_id,
    p_reviewed_player_id,
    p_skill_rating,
    p_attitude_rating,
    p_sportsmanship_rating,
    p_reliability_rating,
    p_felt_safe,
    nullif(btrim(p_private_safety_note), '')
  )
  on conflict (reviewer_id, reviewed_player_id) do nothing
  returning review_id into new_review_id;

  if new_review_id is null then
    raise exception 'You have already reviewed this player.';
  end if;

  return new_review_id;
end;
$$;

create or replace function public.get_rally_player_review_summary(
  p_player_id uuid
)
returns table (
  review_count integer,
  average_skill numeric,
  average_attitude numeric,
  average_sportsmanship numeric,
  average_reliability numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  total_reviews integer;
begin
  if actor_id is null then
    raise exception 'Sign in to view player review summaries.';
  end if;

  select count(*)::integer into total_reviews
  from public.rally_player_reviews review
  where review.reviewed_player_id = p_player_id;

  if total_reviews < 3 then
    return query select 0, null::numeric, null::numeric, null::numeric, null::numeric;
    return;
  end if;

  return query
  select total_reviews,
    round(avg(review.skill_rating)::numeric, 1),
    round(avg(review.attitude_rating)::numeric, 1),
    round(avg(review.sportsmanship_rating)::numeric, 1),
    round(avg(review.reliability_rating)::numeric, 1)
  from public.rally_player_reviews review
  where review.reviewed_player_id = p_player_id;
end;
$$;

revoke all on function public.get_rally_review_targets() from public, anon;
grant execute on function public.get_rally_review_targets() to authenticated;
revoke all on function public.submit_rally_player_review(text, uuid, smallint, smallint, smallint, smallint, boolean, text)
  from public, anon;
grant execute on function public.submit_rally_player_review(text, uuid, smallint, smallint, smallint, smallint, boolean, text)
  to authenticated;
revoke all on function public.get_rally_player_review_summary(uuid) from public, anon;
grant execute on function public.get_rally_player_review_summary(uuid) to authenticated;

commit;
