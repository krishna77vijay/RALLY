begin;

alter table public.profiles
  add column if not exists age_group text,
  add column if not exists gender text,
  add column if not exists is_admin boolean not null default false;

alter table public.games
  add column if not exists gender_eligibility text not null default 'all';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_age_group_check'
  ) then
    alter table public.profiles
      add constraint profiles_age_group_check
      check (age_group is null or age_group in ('13–15', '15–17', '13–18', '17–19'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_gender_check'
  ) then
    alter table public.profiles
      add constraint profiles_gender_check
      check (gender is null or gender in ('girl', 'boy', 'prefer_not_to_say'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.games'::regclass
      and conname = 'games_gender_eligibility_check'
  ) then
    alter table public.games
      add constraint games_gender_eligibility_check
      check (gender_eligibility in ('all', 'girl', 'boy'));
  end if;
end
$$;

do $$
begin
  update public.profiles
  set is_admin = true
  where id = '5c59c6ac-f5dc-40ca-980a-4bc471d9af50'::uuid;

  if not found then
    raise exception 'Could not assign RALLY admin: no profile exists for the supplied Supabase Auth user UUID.';
  end if;
end
$$;

create or replace function public.is_rally_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.is_admin
  );
$$;

revoke all on function public.is_rally_admin() from public;
grant execute on function public.is_rally_admin() to anon, authenticated;

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

create or replace function public.protect_rally_admin_flag()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_admin
      and current_user not in ('postgres', 'supabase_admin', 'service_role')
    then
      raise exception 'Only a database administrator can change the RALLY admin role.';
    end if;
  elsif new.is_admin is distinct from old.is_admin
    and current_user not in ('postgres', 'supabase_admin', 'service_role')
  then
    raise exception 'Only a database administrator can change the RALLY admin role.';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_rally_admin_flag on public.profiles;
create trigger protect_rally_admin_flag
  before insert or update of is_admin on public.profiles
  for each row
  execute function public.protect_rally_admin_flag();

revoke all on function public.protect_rally_admin_flag() from public, anon, authenticated;

drop policy if exists "RALLY public or friends game visibility" on public.games;
create policy "RALLY public or friends game visibility"
  on public.games
  as restrictive
  for select
  to anon, authenticated
  using (
    status = 'published'
    and (
      public.is_rally_admin()
      or visibility = 'public'
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
      public.is_rally_admin()
      or visibility = 'public'
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

notify pgrst, 'reload schema';

commit;
