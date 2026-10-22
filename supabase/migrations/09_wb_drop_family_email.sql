-- Email updates scrapped: remove job, function, tables.
select cron.unschedule(jobid) from cron.job where jobname = 'wb-family-email';
drop function if exists private.wb_family_email_tick();
drop table if exists public.wb_family_subscribers;
drop table if exists public.wb_family_email_state;
