-- Proactivity heartbeat: pg_cron wakes the app every 5 minutes via pg_net.
-- The app URL and shared secret live in Supabase Vault (set by
-- scripts/bootstrap-prod.ts), never in the repo. If they are missing the tick is a no-op.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.cron_tick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  req_id bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'app_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_url is null or v_secret is null then
    return null;
  end if;
  select net.http_post(
    url := v_url || '/api/cron/tick',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'),
    body := jsonb_build_object('source', 'pg_cron', 'at', now()),
    timeout_milliseconds := 25000
  ) into req_id;
  return req_id;
end
$$;

revoke execute on function public.cron_tick() from public, anon, authenticated;

select cron.schedule('agent-tick', '*/5 * * * *', 'select public.cron_tick()');

-- Keep pg_net response table small.
select cron.schedule('net-cleanup', '17 4 * * *',
  $$delete from net._http_response where created < now() - interval '2 days'$$);
