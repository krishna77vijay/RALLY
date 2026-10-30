begin;

alter table public.games
  drop constraint if exists games_sport_check;

alter table public.games
  add constraint games_sport_check
  check (
    sport in (
      'Basketball',
      'Football',
      'Badminton',
      'Tennis',
      'Pickleball',
      'Cricket',
      'Volleyball'
    )
  );

commit;
