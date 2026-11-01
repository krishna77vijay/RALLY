begin;

alter table public.games
  add column if not exists venue_type text;

update public.games
set venue_type = case
  when lower(coalesce(venue, '')) like '%school%' then 'school'
  when lower(coalesce(venue, '')) like '%park%' then 'community_park'
  when lower(coalesce(venue, '')) like '%sports cent%'
    or lower(coalesce(venue, '')) like '%sports center%' then 'sports_centre'
  when lower(coalesce(venue, '')) like '%community cent%'
    or lower(coalesce(venue, '')) like '%community hall%' then 'community_centre'
  when lower(coalesce(venue, '')) like '%gym%'
    or lower(coalesce(venue, '')) like '%indoor%' then 'indoor_gym'
  when lower(coalesce(venue, '')) like '%court%' then 'public_court'
  else 'other'
end
where venue_type is null;

alter table public.games
  alter column venue_type set default 'other',
  alter column venue_type set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.games'::regclass
      and conname = 'games_venue_type_check'
  ) then
    alter table public.games
      add constraint games_venue_type_check
      check (
        venue_type in (
          'school',
          'community_park',
          'sports_centre',
          'public_court',
          'indoor_gym',
          'community_centre',
          'other'
        )
      );
  end if;
end
$$;

commit;
