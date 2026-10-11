-- Per-part execution ledger. Existing files, projects and crops are untouched.
create table public.reference_capture_files (
 id uuid primary key default gen_random_uuid(), created_by uuid not null references auth.users(id),
 task_id uuid not null references public.reference_capture_tasks(id),
 part_index integer not null check(part_index between 1 and 500),
 expected_count integer not null check(expected_count between 1 and 500),
 phase text not null default 'pending' check(phase in ('pending','downloaded','uploading','verifying','complete','failed')),
 original_filename text, sha256 text, master_id uuid references public.artwork_masters(id), error text,
 updated_at timestamptz not null default now(),
 unique(created_by,task_id,part_index), check(part_index<=expected_count),
 check(sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
 check(phase<>'complete' or (master_id is not null and sha256 is not null))
);
alter table public.reference_capture_files enable row level security;
revoke all on public.reference_capture_files from anon,authenticated;
grant select,insert,update on public.reference_capture_files to authenticated;
grant all on public.reference_capture_files to service_role;
create policy "own capture files read" on public.reference_capture_files for select to authenticated using(created_by=(select auth.uid()));
create policy "own capture files insert" on public.reference_capture_files for insert to authenticated
 with check(created_by=(select auth.uid()) and exists(select 1 from public.reference_capture_tasks t where t.id=task_id and t.created_by=(select auth.uid())) and (master_id is null or exists(select 1 from public.artwork_masters m where m.id=master_id and m.created_by=(select auth.uid()))));
create policy "own capture files update" on public.reference_capture_files for update to authenticated
 using(created_by=(select auth.uid())) with check(created_by=(select auth.uid()) and exists(select 1 from public.reference_capture_tasks t where t.id=task_id and t.created_by=(select auth.uid())) and (master_id is null or exists(select 1 from public.artwork_masters m where m.id=master_id and m.created_by=(select auth.uid()))));
create function public.register_capture_original(p_task_id uuid,p_part_index integer,p_expected_count integer,p_filename text,
 p_sha256 text,p_mime text,p_width integer,p_height integer,p_bytes bigint,p_title text default '',p_author text default '',p_era text default '')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t public.reference_capture_tasks; s record; p public.artwork_projects; m public.artwork_masters; path text; object_bytes bigint;
begin
 if auth.uid() is null then raise exception '请先登录' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select * into strict t from public.reference_capture_tasks where id=p_task_id and created_by=auth.uid() for update;
 if t.paused then raise exception '收藏任务已暂停'; end if;
 if p_sha256 !~ '^[a-f0-9]{64}$' or p_bytes<=0 or p_width<=0 or p_height<=0 or p_part_index<1 or p_part_index>p_expected_count or p_expected_count>500 then raise exception '母图参数无效'; end if;
 if p_mime not in ('image/jpeg','image/png','image/webp') then raise exception '不支持此原图格式'; end if;
 if exists(select 1 from public.reference_capture_files where task_id=t.id and expected_count<>p_expected_count) then raise exception '母图总张数与已有分段记录不一致'; end if;
 if exists(select 1 from public.reference_capture_files where task_id=t.id and part_index<>p_part_index and sha256=p_sha256) then raise exception '不同分段使用了相同原图，请核对页序'; end if;
 select * into strict s from public.reference_capture_status where id=t.id;
 if s.candidate_count>1 and t.project_id is null then raise exception '来源项目有歧义，需要人工确认'; end if;
 if s.resolved_master_id is not null then raise exception '此来源关联旧独立母图，需要人工归并项目'; end if;
 path := 'masters/'||auth.uid()||'/'||p_sha256||case p_mime when 'image/jpeg' then '.jpg' when 'image/png' then '.png' else '.webp' end;
 select (metadata->>'size')::bigint into object_bytes from storage.objects where bucket_id='art-reference-images' and name=path;
 if object_bytes is distinct from p_bytes then raise exception '云端原文件不存在或字节数不匹配'; end if;
 if s.resolved_project_id is not null then
  select * into strict p from public.artwork_projects where id=s.resolved_project_id and created_by=auth.uid();
  if public.ltfc_source_key(p.source_url) is distinct from t.source_type||':'||t.source_id then raise exception '已选项目来源不匹配'; end if;
 else
  insert into public.artwork_projects(created_by,title,author,era,source_url)
  values(auth.uid(),left(coalesce(nullif(t.title,''),nullif(btrim(p_title),''),'作品 '||t.source_id),180),left(coalesce(nullif(t.author,''),p_author),120),left(coalesce(nullif(t.era,''),p_era),100),t.source_url) returning * into p;
 end if;
 select * into m from public.artwork_masters where created_by=auth.uid() and sha256=p_sha256;
 if m.id is not null then
  if m.project_id is distinct from p.id then raise exception '相同原图已属于其他项目，需要人工确认'; end if;
  if m.original_bytes<>p_bytes or m.original_width<>p_width or m.original_height<>p_height or m.mime_type<>p_mime then raise exception '已有母图元数据与原文件不一致'; end if;
  update public.artwork_masters set verified_sha256=p_sha256,verified_at=now() where id=m.id returning * into m;
 else
  insert into public.artwork_masters(created_by,project_id,part_index,part_label,title,author,era,source_url,original_filename,mime_type,original_width,original_height,original_bytes,sha256,storage_path,verified_sha256,verified_at)
  values(auth.uid(),p.id,coalesce((select max(part_index) from public.artwork_masters where project_id=p.id),0)+1,'来源第 '||p_part_index||' / '||p_expected_count||' 张',p.title,p.author,p.era,t.source_url,left(p_filename,240),p_mime,p_width,p_height,p_bytes,p_sha256,path,p_sha256,now()) returning * into m;
 end if;
 update public.reference_capture_tasks set project_id=p.id,updated_at=now() where id=t.id and project_id is distinct from p.id;
 insert into public.reference_capture_files(created_by,task_id,part_index,expected_count,phase,original_filename,sha256,master_id)
 values(auth.uid(),t.id,p_part_index,p_expected_count,'complete',left(p_filename,240),p_sha256,m.id)
 on conflict(created_by,task_id,part_index) do update set phase='complete',original_filename=excluded.original_filename,
 sha256=excluded.sha256,master_id=excluded.master_id,error=null,updated_at=now()
 where reference_capture_files.expected_count=excluded.expected_count
  and (reference_capture_files.sha256 is null or reference_capture_files.sha256=excluded.sha256);
 if not found then raise exception '此分段的张数或原图已改变，需要人工确认'; end if;
 return jsonb_build_object('master_id',m.id,'project_id',p.id,'part_index',p_part_index);
end; $$;
revoke all on function public.register_capture_original(uuid,integer,integer,text,text,text,integer,integer,bigint,text,text,text) from public,anon;
grant execute on function public.register_capture_original(uuid,integer,integer,text,text,text,integer,integer,bigint,text,text,text) to authenticated,service_role;
alter publication supabase_realtime add table public.reference_capture_files;
