begin;

create or replace function public.prevent_rally_profile_matching_changes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.is_admin
    or current_user in ('postgres', 'supabase_admin', 'service_role')
  then
    return new;
  end if;

  if old.age_group is not null and new.age_group is distinct from old.age_group then
    raise exception 'Your age group cannot be changed after it has been saved.';
  end if;
  if old.gender is not null and new.gender is distinct from old.gender then
    raise exception 'Your gender cannot be changed after it has been saved.';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_rally_profile_matching_changes on public.profiles;
create trigger prevent_rally_profile_matching_changes
  before update of age_group, gender on public.profiles
  for each row
  execute function public.prevent_rally_profile_matching_changes();

revoke all on function public.prevent_rally_profile_matching_changes() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
