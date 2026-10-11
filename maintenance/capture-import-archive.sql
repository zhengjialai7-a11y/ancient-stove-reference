-- Archive collection JSON and append only new source identities in one transaction.
create table public.reference_capture_imports (
 id uuid primary key default gen_random_uuid(),
 created_by uuid not null references auth.users(id),
 file_name text not null check(length(file_name) between 1 and 240),
 payload jsonb not null check(octet_length(payload::text)<=8388608),
 content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
 item_count integer not null check(item_count>0),
 added_count integer not null check(added_count>=0),
 existing_count integer not null check(existing_count>=0),
 invalid_count integer not null check(invalid_count>=0),
 duplicate_count integer not null check(duplicate_count>=0),
 new_task_ids uuid[] not null default '{}',
 created_at timestamptz not null default now(),
 unique(created_by,content_sha256),
 check(added_count+existing_count=item_count),
 check(cardinality(new_task_ids)=added_count)
);
create index reference_capture_imports_owner_date_idx on public.reference_capture_imports(created_by,created_at desc,id);
alter table public.reference_capture_imports enable row level security;
revoke all on public.reference_capture_imports from anon,authenticated;
grant select,insert on public.reference_capture_imports to authenticated;
grant all on public.reference_capture_imports to service_role;
create policy "own capture imports read" on public.reference_capture_imports for select to authenticated
 using(created_by=(select auth.uid()));
create policy "own capture imports insert" on public.reference_capture_imports for insert to authenticated
 with check(created_by=(select auth.uid()));

create function public.import_reference_capture_json(p_payload jsonb,p_file_name text default '收藏清单.json') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 owner_id uuid := auth.uid(); rows_json jsonb; row_json jsonb;
 seen jsonb := '{}'; identity_key text; source_id_value text; source_type_value text; phase_value text;
 file_hash text; archive_id uuid; task_id uuid; new_ids uuid[] := '{}'; next_order integer;
 valid_count integer := 0; added integer := 0; existing integer := 0; invalid integer := 0; duplicates integer := 0;
 reused boolean := false;
begin
 if owner_id is null then raise exception '请先登录' using errcode='42501'; end if;
 if p_payload is null or octet_length(p_payload::text)>8388608 then raise exception '收藏 JSON 不能超过 8MB'; end if;
 rows_json := case when jsonb_typeof(p_payload)='array' then p_payload
  else coalesce(p_payload->'items',p_payload#>'{observedFavorites,rows}',p_payload->'rows') end;
 if jsonb_typeof(rows_json) is distinct from 'array' then raise exception 'JSON 中找不到收藏记录数组'; end if;
 if jsonb_array_length(rows_json)>20000 then raise exception '单次最多导入 20000 条记录'; end if;

 -- Serialize imports for this account; the unique task constraint also protects older clients.
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
 file_hash := encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 select id into archive_id from public.reference_capture_imports where created_by=owner_id and content_sha256=file_hash;
 reused := archive_id is not null;
 select coalesce(max(queue_order),-1)+1 into next_order from public.reference_capture_tasks where created_by=owner_id;

 for row_json in select value from jsonb_array_elements(rows_json) loop
  if jsonb_typeof(row_json)<>'object' then invalid:=invalid+1; continue; end if;
  source_id_value := lower(btrim(coalesce(nullif(row_json->>'source_id',''),nullif(row_json->>'sourceId',''),nullif(row_json->>'resourceId',''),row_json#>>'{resource,id}','')));
  source_type_value := upper(btrim(coalesce(nullif(row_json->>'source_type',''),nullif(row_json->>'sourceType',''),nullif(row_json#>>'{resource,type}',''),row_json#>>'{resource,src}','')));
  if source_id_value !~ '^[a-f0-9]{24}$' or source_type_value !~ '^[A-Z0-9_]{3,20}$' then invalid:=invalid+1; continue; end if;
  identity_key := source_type_value||':'||source_id_value;
  if seen ? identity_key then duplicates:=duplicates+1; continue; end if;
  seen := seen||jsonb_build_object(identity_key,true); valid_count:=valid_count+1;
  phase_value := coalesce(nullif(row_json->>'phase',''),row_json->>'status');
  if phase_value is null or phase_value not in ('pending','needs_review','downloaded','failed') then
   phase_value := case when source_type_value='SUHA' then 'pending' else 'needs_review' end;
  end if;
  task_id := null;
  insert into public.reference_capture_tasks(created_by,source_type,source_id,source_url,title,author,era,
   favorite_line_id,queue_order,phase,paused,notes,download_filename,legacy_status)
  values(owner_id,source_type_value,source_id_value,
   case when source_type_value='SUHA' then 'https://g2.ltfc.net/view/SUHA/'||source_id_value end,
   left(btrim(coalesce(row_json->>'title','')),180),left(btrim(coalesce(row_json->>'author','')),120),left(coalesce(row_json->>'era',''),100),
   nullif(left(coalesce(nullif(row_json->>'favorite_line_id',''),nullif(row_json->>'lineId',''),row_json->>'id',''),80),''),
   next_order,phase_value,coalesce(row_json->'paused'='true'::jsonb,false),left(coalesce(row_json->>'notes',''),2000),
   nullif(coalesce(nullif(row_json->>'download_filename',''),row_json->>'downloadFilename'),''),
   nullif(coalesce(nullif(row_json->>'legacy_status',''),row_json->>'status'),''))
  on conflict(created_by,source_type,source_id) do nothing returning id into task_id;
  if task_id is null then existing:=existing+1;
  else added:=added+1; next_order:=next_order+1; new_ids:=array_append(new_ids,task_id); end if;
 end loop;
 if valid_count=0 then raise exception '未找到有效来源作品 ID'; end if;
 if not reused then
  insert into public.reference_capture_imports(created_by,file_name,payload,content_sha256,item_count,added_count,existing_count,invalid_count,duplicate_count,new_task_ids)
  values(owner_id,left(coalesce(nullif(btrim(p_file_name),''),'收藏清单.json'),240),p_payload,file_hash,valid_count,added,existing,invalid,duplicates,new_ids)
  returning id into archive_id;
 end if;
 return jsonb_build_object('id',archive_id,'item_count',valid_count,'added_count',added,'existing_count',existing,
  'invalid_count',invalid,'duplicate_count',duplicates,'new_task_ids',to_jsonb(new_ids),'reused_archive',reused);
end; $$;
revoke all on function public.import_reference_capture_json(jsonb,text) from public,anon;
grant execute on function public.import_reference_capture_json(jsonb,text) to authenticated,service_role;
alter publication supabase_realtime add table public.reference_capture_imports;
