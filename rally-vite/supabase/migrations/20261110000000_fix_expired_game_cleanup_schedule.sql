begin;

create extension if not exists pg_cron;

create or replace function public.delete_expired_rally_games()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer;
begin
  delete from public.rally_game_completion_confirmations confirmation
  where confirmation.game_id in (
    select game.id::text
    from public.games game
    where game.starts_at <= clock_timestamp() - interval '12 hours'
       or lower(game.status::text) = 'completed'
  );

  delete from public.games game
  where game.starts_at <= clock_timestamp() - interval '12 hours'
     or lower(game.status::text) = 'completed';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.delete_expired_rally_games() from public, anon, authenticated;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'rally-delete-expired-games'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;

  perform cron.schedule(
    'rally-delete-expired-games',
    '*/10 * * * *',
    'select public.delete_expired_rally_games();'
  );
end
$$;

commit;
