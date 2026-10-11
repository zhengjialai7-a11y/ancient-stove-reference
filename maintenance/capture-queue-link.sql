-- Shared collection queue. No existing artwork/crop/reference data is rewritten.
create or replace function public.ltfc_source_key(url text) returns text
language sql immutable strict security invoker set search_path = '' as $$
 select case when url ~* '^https://g2[.]ltfc[.]net/view/[A-Z0-9_]+/[a-f0-9]{24}([/?#]|$)'
 then upper((regexp_match(url, '^https://g2[.]ltfc[.]net/view/([A-Z0-9_]+)/([a-f0-9]{24})([/?#]|$)', 'i'))[1]) || ':' || lower((regexp_match(url, '^https://g2[.]ltfc[.]net/view/([A-Z0-9_]+)/([a-f0-9]{24})([/?#]|$)', 'i'))[2]) end;
$$;
revoke all on function public.ltfc_source_key(text) from public;
grant execute on function public.ltfc_source_key(text) to authenticated, service_role;

alter table public.artwork_masters add column if not exists verified_sha256 text;
alter table public.artwork_masters add column if not exists verified_at timestamptz;
alter table public.artwork_masters add constraint artwork_master_verification_check
 check ((verified_sha256 is null and verified_at is null) or
 (verified_sha256 is not null and verified_sha256 = sha256 and verified_sha256 ~ '^[a-f0-9]{64}$' and verified_at is not null));
create or replace function public.invalidate_master_verification() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
 if (new.storage_path,new.sha256,new.original_bytes,new.original_width,new.original_height)
 is distinct from (old.storage_path,old.sha256,old.original_bytes,old.original_width,old.original_height) then
  new.verified_sha256 := null; new.verified_at := null;
 end if;
 return new;
end; $$;
revoke all on function public.invalidate_master_verification() from public;
create trigger invalidate_master_verification before update on public.artwork_masters
 for each row execute function public.invalidate_master_verification();

create table public.reference_capture_tasks (
 id uuid primary key default gen_random_uuid(),
 created_by uuid not null references auth.users(id),
 source_type text not null check(source_type ~ '^[A-Z0-9_]{3,20}$'),
 source_id text not null check(source_id ~ '^[a-f0-9]{24}$'),
 source_url text, title text not null default '', author text not null default '', era text not null default '',
 favorite_line_id text, queue_order integer not null default 0,
 phase text not null default 'pending' check(phase in ('pending','needs_review','downloaded','failed')),
 paused boolean not null default false, failure_reason text, last_checked_at timestamptz,
 retry_count integer not null default 0 check(retry_count>=0), download_filename text,
 notes text not null default '', next_action text, legacy_status text,
 project_id uuid references public.artwork_projects(id) on delete set null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(created_by,source_type,source_id),
 check(source_url is null or (public.ltfc_source_key(source_url) is not null and public.ltfc_source_key(source_url)=source_type||':'||source_id))
);
create index reference_capture_tasks_project_idx on public.reference_capture_tasks(project_id);
create index if not exists artwork_masters_project_idx on public.artwork_masters(project_id);
alter table public.reference_capture_tasks enable row level security;
grant select,insert,update on public.reference_capture_tasks to authenticated;
grant all on public.reference_capture_tasks to service_role;
create policy "own capture tasks read" on public.reference_capture_tasks for select to authenticated
 using(created_by=(select auth.uid()));
create policy "own capture tasks insert" on public.reference_capture_tasks for insert to authenticated
 with check(created_by=(select auth.uid()) and (project_id is null or exists
 (select 1 from public.artwork_projects p where p.id=project_id and p.created_by=(select auth.uid()))));
create policy "own capture tasks update" on public.reference_capture_tasks for update to authenticated
 using(created_by=(select auth.uid())) with check(created_by=(select auth.uid()) and
 (project_id is null or exists(select 1 from public.artwork_projects p where p.id=project_id and p.created_by=(select auth.uid()))));

create view public.reference_capture_status with (security_invoker=true) as
with candidates as (
 select t.id task_id,p.id project_id,null::uuid master_id,p.title,p.author,p.era
 from public.reference_capture_tasks t join public.artwork_projects p
 on p.created_by=t.created_by and public.ltfc_source_key(p.source_url)=t.source_type||':'||t.source_id
 union all
 select t.id,null,m.id,m.title,m.author,m.era from public.reference_capture_tasks t
 join public.artwork_masters m on m.created_by=t.created_by and m.project_id is null
 and public.ltfc_source_key(m.source_url)=t.source_type||':'||t.source_id
), links as (
 select t.*, c.candidate_count,c.candidate_projects,
 case when t.project_id is not null then t.project_id when c.candidate_count=1 then c.only_project end resolved_project_id,
 case when t.project_id is null and c.candidate_count=1 then c.only_master end resolved_master_id,
 coalesce(nullif(t.title,''),p.title,case when c.candidate_count=1 then c.title end,'') display_title,
 coalesce(nullif(t.author,''),p.author,case when c.candidate_count=1 then c.author end,'') display_author,
 coalesce(nullif(t.era,''),p.era,case when c.candidate_count=1 then c.era end,'') display_era
 from public.reference_capture_tasks t
 left join public.artwork_projects p on p.id=t.project_id and p.created_by=t.created_by
 left join lateral (select count(*)::int candidate_count,
 (array_agg(project_id))[1] only_project,(array_agg(master_id))[1] only_master,
 (array_agg(title))[1] title,(array_agg(author))[1] author,(array_agg(era))[1] era,
 coalesce(jsonb_agg(jsonb_build_object('id',project_id,'title',title)) filter(where project_id is not null),'[]') candidate_projects
 from candidates c where c.task_id=t.id) c on true
), facts as (
 select l.*, a.master_count,a.verified_count,a.masters,k.draft_count,k.published_count
 from links l left join lateral (
 select count(*)::int master_count,
 count(*) filter(where m.verified_sha256=m.sha256 and m.verified_at is not null)::int verified_count,
 coalesce(jsonb_agg(jsonb_build_object('id',m.id,'filename',m.original_filename,'width',m.original_width,'height',m.original_height,
 'bytes',m.original_bytes,'sha256',m.sha256,'verified_at',m.verified_at,'verified',m.verified_sha256=m.sha256 and m.verified_at is not null)
 order by m.part_index,m.created_at),'[]') masters
 from public.artwork_masters m where m.created_by=l.created_by and
 ((l.resolved_project_id is not null and m.project_id=l.resolved_project_id) or m.id=l.resolved_master_id)
 ) a on true left join lateral (
 select count(*) filter(where c.status='draft')::int draft_count,count(*) filter(where c.status='published')::int published_count
 from public.artwork_crops c join public.artwork_masters m on m.id=c.master_id
 where m.created_by=l.created_by and ((l.resolved_project_id is not null and m.project_id=l.resolved_project_id) or m.id=l.resolved_master_id)
 ) k on true
)
select f.*, case
 when project_id is null and candidate_count>1 then 'needs_review'
 when master_count>0 and verified_count<master_count then 'uploaded_unverified'
 when verified_count>0 and draft_count>0 then 'drafts_ready'
 when verified_count>0 and published_count>0 then 'published'
 when verified_count>0 then 'uploaded'
 else phase end live_status
from facts f;
grant select on public.reference_capture_status to authenticated,service_role;
do $$ declare t text; begin
 foreach t in array array['reference_capture_tasks','artwork_masters','artwork_crops','artwork_projects'] loop
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
 execute format('alter publication supabase_realtime add table public.%I',t);
 end if; end loop;
end; $$;
