-- Original image bytes may live in R2; accounts, identities and native crop geometry stay here.
-- Initially disabled. Configure the stable HTTPS gateway origin and its matching runtime
-- HMAC secret using an administrator-only setup; never expose the secret through the Data API.
-- Existing Supabase objects, mother IDs, draft IDs and capture progress are not rewritten.

create schema if not exists original_storage_private;
revoke all on schema original_storage_private from public, anon, authenticated;
grant usage on schema original_storage_private to authenticated;

create table original_storage_private.config (
 singleton boolean primary key default true check (singleton),
 enabled boolean not null default false,
 endpoint text,
 hmac_secret text not null default pg_catalog.encode(extensions.gen_random_bytes(32),'hex'),
 constraint original_storage_endpoint_origin check (
  endpoint is null or (pg_catalog.length(endpoint) <= 300
   and endpoint ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
   and endpoint !~ '^https://[0-9]+(\.[0-9]+){3}$' and endpoint !~ '\.(localhost|local)$')
 ),
 constraint original_storage_enabled_endpoint check (not enabled or endpoint is not null),
 constraint original_storage_secret_shape check (hmac_secret ~ '^[a-f0-9]{64}$')
);
insert into original_storage_private.config(singleton) values(true);
alter table original_storage_private.config enable row level security;
revoke all on original_storage_private.config from public, anon, authenticated, service_role;

create table original_storage_private.receipts (
 created_by uuid not null references auth.users(id),
 storage_path text not null,
 sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
 original_bytes bigint not null check (original_bytes > 0),
 mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
 storage_origin text not null,
 etag text not null check (pg_catalog.length(etag) between 1 and 160 and etag !~ '[[:cntrl:]]'),
 issued_at bigint not null check (issued_at > 0),
 checksum_verified boolean not null default false check (checksum_verified),
 verified_at timestamptz not null default pg_catalog.now(),
 primary key(created_by,storage_path),
 constraint original_storage_receipt_path check (
  storage_path = 'masters/' || created_by::text || '/' || sha256 ||
   case mime_type when 'image/jpeg' then '.jpg' when 'image/png' then '.png' else '.webp' end
 )
);
alter table original_storage_private.receipts enable row level security;
revoke all on original_storage_private.receipts from public, anon, authenticated, service_role;

alter table public.artwork_masters
 add column storage_provider text not null default 'supabase',
 add column storage_origin text,
 add constraint artwork_masters_storage_provider check (storage_provider in ('supabase','r2')),
 add constraint artwork_masters_storage_origin check (
  (storage_provider='supabase' and storage_origin is null)
  or (storage_provider='r2' and storage_origin is not null and
      pg_catalog.length(storage_origin) <= 300
      and storage_origin ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
      and storage_origin !~ '^https://[0-9]+(\.[0-9]+){3}$' and storage_origin !~ '\.(localhost|local)$')
 );

-- Private definer functions access only protected config/receipts, and always check auth.uid().
-- Public RPC wrappers remain invoker functions; private schema is not a Data API exposed schema.
create function original_storage_private.get_config()
returns jsonb language plpgsql security definer set search_path='' as $$
declare c original_storage_private.config;
begin
 if auth.uid() is null then raise exception '请先登录' using errcode='42501'; end if;
 select * into strict c from original_storage_private.config where singleton;
 return pg_catalog.jsonb_build_object('provider',case when c.enabled then 'r2' else 'supabase' end,
  'enabled',c.enabled,'endpoint',c.endpoint,
  'readOrigins',case when c.endpoint is null then '[]'::jsonb else pg_catalog.jsonb_build_array(c.endpoint) end);
end; $$;
revoke all on function original_storage_private.get_config() from public, anon;
grant execute on function original_storage_private.get_config() to authenticated;

create function public.get_original_storage_config()
returns jsonb language sql security invoker set search_path='' as $$
 select original_storage_private.get_config();
$$;
revoke all on function public.get_original_storage_config() from public, anon;
grant execute on function public.get_original_storage_config() to authenticated;

create function original_storage_private.record_receipt(p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 uid uuid := auth.uid(); c original_storage_private.config;
 owner_text text; origin_text text; path_text text; sha_text text; mime_text text; etag_text text;
 byte_count bigint; issued bigint; signature_text text; canonical text; expected_signature text;
 prior original_storage_private.receipts;
begin
 if uid is null then raise exception '请先登录' using errcode='42501'; end if;
 if p_receipt is null or pg_catalog.jsonb_typeof(p_receipt) <> 'object'
  or not (p_receipt ?& array['owner','storage_origin','path','sha256','bytes','mime','etag','issued_at','signature'])
  or exists(select 1 from pg_catalog.jsonb_object_keys(p_receipt) as k(key)
            where k.key <> all(array['owner','storage_origin','path','sha256','bytes','mime','etag','issued_at','signature'])) then
  raise exception 'R2 校验凭据格式无效' using errcode='22023';
 end if;
 if pg_catalog.jsonb_typeof(p_receipt->'owner') is distinct from 'string'
  or pg_catalog.jsonb_typeof(p_receipt->'storage_origin') is distinct from 'string'
  or pg_catalog.jsonb_typeof(p_receipt->'path') is distinct from 'string'
  or pg_catalog.jsonb_typeof(p_receipt->'sha256') is distinct from 'string'
  or pg_catalog.jsonb_typeof(p_receipt->'mime') is distinct from 'string'
  or pg_catalog.jsonb_typeof(p_receipt->'etag') is distinct from 'string'
  or pg_catalog.jsonb_typeof(p_receipt->'signature') is distinct from 'string'
  or pg_catalog.jsonb_typeof(p_receipt->'bytes') is distinct from 'number'
  or pg_catalog.jsonb_typeof(p_receipt->'issued_at') is distinct from 'number' then
  raise exception 'R2 校验凭据格式无效' using errcode='22023';
 end if;
 owner_text := p_receipt->>'owner'; origin_text := p_receipt->>'storage_origin';
 path_text := p_receipt->>'path'; sha_text := p_receipt->>'sha256'; mime_text := p_receipt->>'mime';
 etag_text := p_receipt->>'etag'; signature_text := p_receipt->>'signature';
 if owner_text is distinct from uid::text then raise exception 'R2 校验凭据不属于当前账号' using errcode='42501'; end if;
 if sha_text !~ '^[a-f0-9]{64}$' or signature_text !~ '^[a-f0-9]{64}$'
  or (p_receipt->>'bytes') !~ '^[1-9][0-9]{0,15}$'
  or (p_receipt->>'issued_at') !~ '^[1-9][0-9]{0,12}$'
  or mime_text not in ('image/jpeg','image/png','image/webp')
  or pg_catalog.length(etag_text) not between 1 and 160 or etag_text ~ '[[:cntrl:]]'
  or path_text is distinct from ('masters/' || uid::text || '/' || sha_text ||
      case mime_text when 'image/jpeg' then '.jpg' when 'image/png' then '.png' else '.webp' end) then
  raise exception 'R2 校验凭据参数无效' using errcode='22023';
 end if;
 byte_count := (p_receipt->>'bytes')::bigint; issued := (p_receipt->>'issued_at')::bigint;
 if byte_count > 9007199254740991 then raise exception 'R2 文件字节数超出精确整数范围' using errcode='22023'; end if;
 if pg_catalog.abs(pg_catalog.date_part('epoch',pg_catalog.clock_timestamp()) - issued) > 900 then
  raise exception 'R2 校验凭据已过期，请重新核验' using errcode='22023';
 end if;
 select * into strict c from original_storage_private.config where singleton;
 if not c.enabled then raise exception 'R2 母图上传尚未启用' using errcode='55000'; end if;
 if origin_text is distinct from c.endpoint then raise exception 'R2 校验凭据来源不受信任' using errcode='42501'; end if;
 canonical := pg_catalog.array_to_string(array['r2-v1',owner_text,origin_text,path_text,sha_text,
                   byte_count::text,mime_text,etag_text,issued::text],E'\n');
 -- The runtime secret is the UTF-8 hex string itself, rather than decoded binary hex.
 expected_signature := pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(canonical,'UTF8'),
                          pg_catalog.convert_to(c.hmac_secret,'UTF8'),'sha256'),'hex');
 if signature_text is distinct from expected_signature then raise exception 'R2 校验凭据签名无效' using errcode='42501'; end if;
 -- A hash-addressed object cannot silently change identity or metadata on replay.
 select * into prior from original_storage_private.receipts where created_by=uid and storage_path=path_text for update;
 if found and (prior.sha256,prior.original_bytes,prior.mime_type,prior.storage_origin)
      is distinct from (sha_text,byte_count,mime_text,origin_text) then
  raise exception 'R2 已有原文件身份与凭据不一致' using errcode='22023';
 end if;
 insert into original_storage_private.receipts(created_by,storage_path,sha256,original_bytes,mime_type,
             storage_origin,etag,issued_at,checksum_verified,verified_at)
 values(uid,path_text,sha_text,byte_count,mime_text,origin_text,etag_text,issued,true,pg_catalog.clock_timestamp())
 on conflict(created_by,storage_path) do update
 set etag=excluded.etag,issued_at=excluded.issued_at,verified_at=excluded.verified_at
 where receipts.sha256=excluded.sha256 and receipts.original_bytes=excluded.original_bytes
  and receipts.mime_type=excluded.mime_type and receipts.storage_origin=excluded.storage_origin;
 if not found then raise exception 'R2 已有原文件身份与凭据不一致' using errcode='22023'; end if;
 return pg_catalog.jsonb_build_object('provider','r2','storage_path',path_text,'sha256',sha_text,
                                     'bytes',byte_count,'verified',true);
end; $$;
revoke all on function original_storage_private.record_receipt(jsonb) from public, anon;
grant execute on function original_storage_private.record_receipt(jsonb) to authenticated;

create function public.record_r2_original_receipt(p_receipt jsonb)
returns jsonb language sql security invoker set search_path='' as $$
 select original_storage_private.record_receipt(p_receipt);
$$;
revoke all on function public.record_r2_original_receipt(jsonb) from public, anon;
grant execute on function public.record_r2_original_receipt(jsonb) to authenticated;

create function original_storage_private.has_receipt(p_created_by uuid,p_storage_path text,p_sha256 text,
 p_bytes bigint,p_mime text,p_storage_origin text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or p_created_by is distinct from auth.uid() then
  raise exception '没有核验这幅母图的权限' using errcode='42501';
 end if;
 -- Disabling new uploads does not disable reads, verification or publication of existing originals.
 return exists(select 1 from original_storage_private.receipts r
  join original_storage_private.config c on c.singleton and c.endpoint=r.storage_origin
  where r.created_by=p_created_by and r.storage_path=p_storage_path and r.sha256=p_sha256
   and r.original_bytes=p_bytes and r.mime_type=p_mime and r.storage_origin=p_storage_origin
   and r.checksum_verified);
end; $$;
revoke all on function original_storage_private.has_receipt(uuid,text,text,bigint,text,text) from public, anon;
grant execute on function original_storage_private.has_receipt(uuid,text,text,bigint,text,text) to authenticated;

create function public.verify_r2_original_receipt(p_created_by uuid,p_storage_path text,p_sha256 text,
 p_bytes bigint,p_mime text,p_storage_origin text)
returns boolean language sql security invoker set search_path='' as $$
 select original_storage_private.has_receipt(p_created_by,p_storage_path,p_sha256,p_bytes,p_mime,p_storage_origin);
$$;
revoke all on function public.verify_r2_original_receipt(uuid,text,text,bigint,text,text) from public, anon;
grant execute on function public.verify_r2_original_receipt(uuid,text,text,bigint,text,text) to authenticated;

create function public.guard_r2_master_receipt()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.storage_provider='r2' and not public.verify_r2_original_receipt(new.created_by,new.storage_path,
      new.sha256,new.original_bytes,new.mime_type,new.storage_origin) then
  raise exception 'R2 原文件没有可信的完整字节校验凭据' using errcode='23514';
 end if;
 return new;
end; $$;
revoke all on function public.guard_r2_master_receipt() from public, anon;
create trigger guard_r2_master_receipt before insert or update on public.artwork_masters
 for each row execute function public.guard_r2_master_receipt();

create or replace function public.invalidate_master_verification()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if (new.storage_provider,new.storage_origin,new.storage_path,new.sha256,new.original_bytes,
     new.original_width,new.original_height,new.mime_type)
 is distinct from (old.storage_provider,old.storage_origin,old.storage_path,old.sha256,old.original_bytes,
     old.original_width,old.original_height,old.mime_type) then
  new.verified_sha256 := null; new.verified_at := null;
 end if;
 return new;
end; $$;

-- One signature with defaults keeps existing callers working and avoids overloaded REST RPC ambiguity.
drop function public.register_capture_original(uuid,integer,integer,text,text,text,integer,integer,bigint,text,text,text);
create function public.register_capture_original(p_task_id uuid,p_part_index integer,p_expected_count integer,p_filename text,
 p_sha256 text,p_mime text,p_width integer,p_height integer,p_bytes bigint,p_title text default '',p_author text default '',p_era text default '',
 p_storage_provider text default 'supabase',p_storage_origin text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t public.reference_capture_tasks; s record; p public.artwork_projects; m public.artwork_masters; path text; object_bytes bigint;
begin
 if auth.uid() is null then raise exception '请先登录' using errcode='42501'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,0));
 select * into strict t from public.reference_capture_tasks where id=p_task_id and created_by=auth.uid() for update;
 if t.paused then raise exception '收藏任务已暂停'; end if;
 if p_sha256 is null or p_sha256 !~ '^[a-f0-9]{64}$' or p_bytes is null or p_bytes<=0
  or p_width is null or p_width<=0 or p_height is null or p_height<=0
  or p_part_index is null or p_part_index<1 or p_expected_count is null or p_expected_count<1
  or p_part_index>p_expected_count or p_expected_count>500 then raise exception '母图参数无效'; end if;
 if p_mime is null or p_mime not in ('image/jpeg','image/png','image/webp') then raise exception '不支持此原图格式'; end if;
 if p_storage_provider is null or p_storage_provider not in ('supabase','r2')
  or (p_storage_provider='supabase' and p_storage_origin is not null) then raise exception '母图存储参数无效'; end if;
 if exists(select 1 from public.reference_capture_files where task_id=t.id and expected_count<>p_expected_count) then raise exception '母图总张数与已有分段记录不一致'; end if;
 if exists(select 1 from public.reference_capture_files where task_id=t.id and part_index<>p_part_index and sha256=p_sha256) then raise exception '不同分段使用了相同原图，请核对页序'; end if;
 select * into strict s from public.reference_capture_status where id=t.id;
 if s.candidate_count>1 and t.project_id is null then raise exception '来源项目有歧义，需要人工确认'; end if;
 if s.resolved_master_id is not null then raise exception '此来源关联旧独立母图，需要人工归并项目'; end if;
 path := 'masters/'||auth.uid()||'/'||p_sha256||case p_mime when 'image/jpeg' then '.jpg' when 'image/png' then '.png' else '.webp' end;
 if p_storage_provider='r2' then
  if not public.verify_r2_original_receipt(auth.uid(),path,p_sha256,p_bytes,p_mime,p_storage_origin) then
   raise exception 'R2 原文件没有可信的完整字节校验凭据';
  end if;
 else
  select (metadata->>'size')::bigint into object_bytes from storage.objects where bucket_id='art-reference-images' and name=path;
  if object_bytes is distinct from p_bytes then raise exception '云端原文件不存在或字节数不匹配'; end if;
 end if;
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
  if m.storage_provider is distinct from p_storage_provider or m.storage_origin is distinct from p_storage_origin or m.storage_path is distinct from path then
   raise exception '已有母图存储位置不同，请先核验迁移';
  end if;
  update public.artwork_masters set verified_sha256=p_sha256,verified_at=now() where id=m.id returning * into m;
 else
  insert into public.artwork_masters(created_by,project_id,part_index,part_label,title,author,era,source_url,original_filename,mime_type,original_width,original_height,original_bytes,sha256,storage_path,storage_provider,storage_origin,verified_sha256,verified_at)
  values(auth.uid(),p.id,coalesce((select max(part_index) from public.artwork_masters where project_id=p.id),0)+1,'来源第 '||p_part_index||' / '||p_expected_count||' 张',p.title,p.author,p.era,t.source_url,left(p_filename,240),p_mime,p_width,p_height,p_bytes,p_sha256,path,p_storage_provider,p_storage_origin,p_sha256,now()) returning * into m;
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
revoke all on function public.register_capture_original(uuid,integer,integer,text,text,text,integer,integer,bigint,text,text,text,text,text) from public,anon;
grant execute on function public.register_capture_original(uuid,integer,integer,text,text,text,integer,integer,bigint,text,text,text,text,text) to authenticated,service_role;

create or replace function public.publish_artwork_crop(p_crop_id uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare c public.artwork_crops%rowtype; m public.artwork_masters%rowtype; old_ref public.references%rowtype;
 ref_id uuid; master_url text;
begin
 if (select auth.uid()) is null then raise exception '请先登录'; end if;
 select * into c from public.artwork_crops where id=p_crop_id for update;
 if not found then raise exception '裁切记录不存在'; end if;
 select * into m from public.artwork_masters where id=c.master_id and created_by = (select auth.uid());
 if not found then raise exception '没有操作这幅作品的权限'; end if;
 if c.status <> 'draft' then raise exception '该裁切已经发布'; end if;
 if c.x+c.w>m.original_width or c.y+c.h>m.original_height then raise exception '裁切范围超出了原图'; end if;
 if m.storage_provider='r2' then
  if m.verified_sha256 is distinct from m.sha256 or m.verified_at is null
   or not public.verify_r2_original_receipt(m.created_by,m.storage_path,m.sha256,m.original_bytes,m.mime_type,m.storage_origin) then
   raise exception 'R2 高清母图尚未通过完整字节校验，不能发布';
  end if;
  master_url := m.storage_origin || '/public/' || m.storage_path;
 else
  if not exists (select 1 from storage.objects where bucket_id='art-reference-images' and name=m.storage_path and (metadata->>'size')::bigint=m.original_bytes) then
   raise exception '云端高清母图不存在或文件尺寸不符，不能发布';
  end if;
  master_url := 'https://otaokoencpoanxjjuqzv.supabase.co/storage/v1/object/public/art-reference-images/' || replace(m.storage_path,' ','%20');
 end if;
 if c.target_reference_id is not null then
  select * into old_ref from public.references where id=c.target_reference_id for update;
  if not found then raise exception '原参考记录不存在'; end if;
  if not (old_ref.work_title = m.title and (
    old_ref.source_url = m.source_url
    or (nullif(m.source_url,'') is not null and substring(m.source_url from '([a-f0-9]{24})') is not null
        and old_ref.source_url like '%' || substring(m.source_url from '([a-f0-9]{24})') || '%')
    or (nullif(m.source_url,'') is null and nullif(old_ref.source_url,'') is null)
  )) then raise exception '目标参考与母图作品不匹配，请检查'; end if;
  insert into public.reference_image_revisions(reference_id,master_id,crop_id,previous_state,changed_by)
  values(old_ref.id,m.id,c.id,to_jsonb(old_ref),(select auth.uid()));
  update public.references set image_url=master_url,highres_url=master_url,
   crop_x=c.x::float8/m.original_width,crop_y=c.y::float8/m.original_height,
   crop_w=c.w::float8/m.original_width,crop_h=c.h::float8/m.original_height,
   updated_by=(select auth.uid()),updated_at=now() where id=old_ref.id;
  ref_id := old_ref.id;
 else
  insert into public.references(title,category_id,sub_category,image_url,highres_url,source_url,
   era,artist,work_title,source_site,crop_x,crop_y,crop_w,crop_h,created_by,updated_by)
  values(c.title,c.category_id,c.sub_category,master_url,master_url,nullif(m.source_url,''),m.era,m.author,m.title,
   case when m.source_url like '%ltfc.net%' then '中华珍宝馆' else '高清母图' end,
   c.x::float8/m.original_width,c.y::float8/m.original_height,c.w::float8/m.original_width,c.h::float8/m.original_height,
   (select auth.uid()),(select auth.uid())) returning id into ref_id;
 end if;
 update public.artwork_crops set published_reference_id=ref_id,status='published',updated_at=now() where id=c.id;
 update public.artwork_masters set status='published',updated_at=now() where id=m.id;
 return ref_id;
end; $$;

-- New exposed RPCs contain no secret and no write permission on private relations.
-- Do not add original_storage_private to PostgREST's exposed schemas.
