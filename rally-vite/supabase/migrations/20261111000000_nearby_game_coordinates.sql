begin;

alter table public.games
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.games'::regclass
      and conname = 'games_coordinates_valid_check'
  ) then
    alter table public.games
      add constraint games_coordinates_valid_check
      check (
        (latitude is null and longitude is null)
        or (
          latitude is not null
          and longitude is not null
          and latitude between -90 and 90
          and longitude between -180 and 180
        )
      );
  end if;
end
$$;

create index if not exists games_nearby_coordinates_idx
  on public.games (latitude, longitude)
  where latitude is not null and longitude is not null;

create or replace function public.find_rally_games_nearby(
  p_latitude double precision,
  p_longitude double precision,
  p_radius_km integer
)
returns table (
  game_id text,
  latitude double precision,
  longitude double precision,
  distance_km double precision
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to find eligible nearby games.';
  end if;
  if p_latitude is null or p_longitude is null
    or p_latitude not between -90 and 90
    or p_longitude not between -180 and 180
  then
    raise exception 'A valid search location is required.';
  end if;
  if p_radius_km is null or p_radius_km not in (5, 10, 25) then
    raise exception 'Choose a nearby search radius of 5, 10, or 25 km.';
  end if;

  return query
  with bounds as (
    select
      p_radius_km::double precision / 110.574 as latitude_delta,
      case
        when greatest(
          abs(greatest(-90, p_latitude - p_radius_km::double precision / 110.574)),
          abs(least(90, p_latitude + p_radius_km::double precision / 110.574))
        ) >= 89.999999
        then 180.0
        else least(
          180.0,
          p_radius_km::double precision / (
            111.320 * abs(cos(radians(greatest(
              abs(greatest(-90, p_latitude - p_radius_km::double precision / 110.574)),
              abs(least(90, p_latitude + p_radius_km::double precision / 110.574))
            ))))
          )
        )
      end as longitude_delta
  ),
  candidates as (
    select
      game.id::text as candidate_game_id,
      game.latitude as candidate_latitude,
      game.longitude as candidate_longitude,
      2 * 6371.0 * asin(sqrt(least(1.0,
        power(sin(radians(game.latitude - p_latitude) / 2), 2)
        + cos(radians(p_latitude))
          * cos(radians(game.latitude))
          * power(sin(radians(game.longitude - p_longitude) / 2), 2)
      ))) as candidate_distance_km
    from public.games game
    cross join bounds
    where game.status::text = 'published'
      and game.starts_at > now()
      and game.latitude is not null
      and game.longitude is not null
      and game.latitude between
        greatest(-90, p_latitude - bounds.latitude_delta)
        and least(90, p_latitude + bounds.latitude_delta)
      and (
        bounds.longitude_delta >= 180
        or abs(mod(
          (game.longitude - p_longitude + 540)::numeric,
          360
        )::double precision - 180) <= bounds.longitude_delta
      )
  )
  select
    candidates.candidate_game_id,
    candidates.candidate_latitude,
    candidates.candidate_longitude,
    candidates.candidate_distance_km
  from candidates
  where candidates.candidate_distance_km <= p_radius_km
  order by candidates.candidate_distance_km, candidates.candidate_game_id;
end;
$$;

revoke all on function public.find_rally_games_nearby(
  double precision, double precision, integer
) from public, anon, authenticated;
grant execute on function public.find_rally_games_nearby(
  double precision, double precision, integer
) to authenticated;

notify pgrst, 'reload schema';

commit;
