begin;

alter table public.rally_friendships enable row level security;

do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'rally_friendships'
  loop
    execute format(
      'drop policy if exists %I on public.rally_friendships',
      existing_policy.policyname
    );
  end loop;
end
$$;

revoke all on table public.rally_friendships from public, anon, authenticated;
grant select, insert, delete on table public.rally_friendships to authenticated;
grant update (status) on table public.rally_friendships to authenticated;

create policy "Users can view their own friendships"
  on public.rally_friendships
  for select
  to authenticated
  using (auth.uid() = user_low or auth.uid() = user_high);

create policy "Users can send friendship requests"
  on public.rally_friendships
  for insert
  to authenticated
  with check (
    auth.uid() = requested_by
    and (auth.uid() = user_low or auth.uid() = user_high)
    and user_low < user_high
    and status = 'pending'
  );

create policy "Recipients can respond to friendship requests"
  on public.rally_friendships
  for update
  to authenticated
  using (
    status = 'pending'
    and auth.uid() in (user_low, user_high)
    and auth.uid() <> requested_by
  )
  with check (
    status in ('accepted', 'declined')
    and auth.uid() in (user_low, user_high)
  );

create policy "Participants can remove friendships"
  on public.rally_friendships
  for delete
  to authenticated
  using (auth.uid() in (user_low, user_high));

commit;
