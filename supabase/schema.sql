-- Hambo's Kitchen Designer: cloud jobs, staff access, customer enquiries.
-- Run once on the hambos-planner Supabase project.

-- Staff allow-list: only these emails can read/write jobs and files.
create table if not exists public.staff (
  email text primary key,
  name text,
  added_at timestamptz not null default now()
);
insert into public.staff(email,name) values
  ('adamduce83@gmail.com','Adam'),
  ('admin@hambos.com.au','Jess')
on conflict (email) do nothing;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff s where lower(s.email) = lower(coalesce(auth.jwt()->>'email','')));
$$;

-- Jobs: one row per job, the planner's full save state in `state`.
create table if not exists public.jobs (
  id text primary key,
  order_ref text,
  customer text,
  rooms text,
  state jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_by text
);
create index if not exists jobs_updated_at_idx on public.jobs(updated_at desc);

-- Enquiries: what "Get My Quote" sends from a customer (no login).
create table if not exists public.enquiries (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text, phone text, email text, suburb text, message text,
  order_ref text, customer text,
  state jsonb not null,
  handled boolean not null default false
);

alter table public.staff enable row level security;
alter table public.jobs enable row level security;
alter table public.enquiries enable row level security;

drop policy if exists staff_read_self on public.staff;
create policy staff_read_self on public.staff for select to authenticated using (public.is_staff());

drop policy if exists jobs_staff_all on public.jobs;
create policy jobs_staff_all on public.jobs for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists enquiries_anyone_insert on public.enquiries;
create policy enquiries_anyone_insert on public.enquiries for insert to anon, authenticated with check (true);
drop policy if exists enquiries_staff_read on public.enquiries;
create policy enquiries_staff_read on public.enquiries for select to authenticated using (public.is_staff());
drop policy if exists enquiries_staff_update on public.enquiries;
create policy enquiries_staff_update on public.enquiries for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- Private bucket for plan sheets (PNG per room, PDFs). Paths: <jobId>/<file>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plans','plans',false, 26214400, array['image/png','application/pdf','application/json'])
on conflict (id) do update set public=false, file_size_limit=26214400, allowed_mime_types=array['image/png','application/pdf','application/json'];

drop policy if exists plans_staff_select on storage.objects;
create policy plans_staff_select on storage.objects for select to authenticated using (bucket_id='plans' and public.is_staff());
drop policy if exists plans_staff_insert on storage.objects;
create policy plans_staff_insert on storage.objects for insert to authenticated with check (bucket_id='plans' and public.is_staff());
drop policy if exists plans_staff_update on storage.objects;
create policy plans_staff_update on storage.objects for update to authenticated using (bucket_id='plans' and public.is_staff());
drop policy if exists plans_staff_delete on storage.objects;
create policy plans_staff_delete on storage.objects for delete to authenticated using (bucket_id='plans' and public.is_staff());

-- keep updated_at honest
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists jobs_touch on public.jobs;
create trigger jobs_touch before update on public.jobs for each row execute function public.touch_updated_at();
