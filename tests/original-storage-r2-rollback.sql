-- Run after maintenance/original-storage-r2.sql as a database administrator.
-- Every test fixture, config change and publication is rolled back. Synthetic signed
-- receipts test the trust boundary, not a real upload; gateway tests cover real bytes.
begin;
create temporary table r2_test_existing_masters as select * from public.artwork_masters;
create temporary table r2_test_existing_crops as select * from public.artwork_crops;
create temporary table r2_test_existing_files as select * from public.reference_capture_files;
create temporary table r2_test_context (
 owner_id uuid not null, other_owner uuid not null, source_id text not null,
 proof jsonb, task_id uuid, master_id uuid, crop_id uuid, reference_id uuid
);
insert into r2_test_context(owner_id,other_owner,source_id)
select id,gen_random_uuid(),substring(replace(gen_random_uuid()::text,'-','') from 1 for 24)
from auth.users order by created_at limit 1;
do $$ begin
 if not exists(select 1 from r2_test_context) then raise exception 'An existing signed-in account is required for this rollback test'; end if;
end; $$;
update original_storage_private.config set enabled=true,endpoint='https://r2-rollback-test.invalid',
 hmac_secret=encode(extensions.gen_random_bytes(32),'hex') where singleton;
update r2_test_context set proof=(
 select jsonb_build_object('owner',owner_id::text,'storage_origin',cfg.endpoint,
  'path','masters/'||owner_id||'/'||payload.sha||'.jpg','sha256',payload.sha,
  'bytes',62914560,'mime','image/jpeg','etag','rollback-test-etag','issued_at',payload.issued,
  'signature',encode(extensions.hmac(convert_to(array_to_string(array['r2-v1',owner_id::text,cfg.endpoint,
   'masters/'||owner_id||'/'||payload.sha||'.jpg',payload.sha,'62914560','image/jpeg','rollback-test-etag',payload.issued::text],E'\n'),'UTF8'),
   convert_to(cfg.hmac_secret,'UTF8'),'sha256'),'hex'))
 from original_storage_private.config cfg cross join lateral (
  select encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex') as sha,
         floor(date_part('epoch',clock_timestamp()))::bigint as issued
 ) payload where cfg.singleton
);
grant select,update on r2_test_context to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
do $$ begin
 begin
  perform public.get_original_storage_config();
  raise exception 'Unauthenticated config accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.record_r2_original_receipt((select proof from r2_test_context));
  raise exception 'Unauthenticated receipt accepted';
 exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claim.sub',(select owner_id::text from r2_test_context),true);
do $$
declare ctx r2_test_context; config jsonb; result jsonb; new_task uuid; new_master uuid; new_crop uuid; new_ref uuid;
begin
 select * into strict ctx from r2_test_context;
 config := public.get_original_storage_config();
 if config->>'provider'<>'r2' or (config->>'enabled')::boolean is not true
   or config->>'endpoint'<>'https://r2-rollback-test.invalid'
   or config->'readOrigins'<>'["https://r2-rollback-test.invalid"]'::jsonb
   or config ? 'hmac_secret' then raise exception 'Public storage config invalid or exposed secret'; end if;
 if has_table_privilege('authenticated','original_storage_private.config','SELECT')
   or has_table_privilege('authenticated','original_storage_private.config','UPDATE')
   or has_table_privilege('authenticated','original_storage_private.receipts','SELECT')
   or has_table_privilege('authenticated','original_storage_private.receipts','INSERT')
   or has_table_privilege('authenticated','original_storage_private.receipts','UPDATE') then
  raise exception 'Authenticated role can access protected private relations';
 end if;
 if has_function_privilege('anon','public.get_original_storage_config()','EXECUTE')
   or has_function_privilege('anon','public.record_r2_original_receipt(jsonb)','EXECUTE')
   or has_function_privilege('anon','public.verify_r2_original_receipt(uuid,text,text,bigint,text,text)','EXECUTE') then
  raise exception 'Anonymous original storage RPC exposed';
 end if;
 begin
  perform public.record_r2_original_receipt(jsonb_set(ctx.proof,'{signature}',to_jsonb(repeat('0',64))));
  raise exception 'Forged HMAC accepted';
 exception when insufficient_privilege then
  if sqlerrm<>'R2 校验凭据签名无效' then raise; end if;
 end;
 begin
  perform public.record_r2_original_receipt(jsonb_set(ctx.proof,'{owner}',to_jsonb(ctx.other_owner::text)));
  raise exception 'Cross-owner signed receipt accepted';
 exception when insufficient_privilege then
  if sqlerrm<>'R2 校验凭据不属于当前账号' then raise; end if;
 end;
 begin
  perform public.verify_r2_original_receipt(ctx.other_owner,ctx.proof->>'path',ctx.proof->>'sha256',62914560,'image/jpeg',ctx.proof->>'storage_origin');
  raise exception 'Cross-owner private receipt lookup accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.record_r2_original_receipt(jsonb_set(ctx.proof,'{storage_origin}',to_jsonb('https://other.invalid'::text)));
  raise exception 'Untrusted origin accepted';
 exception when insufficient_privilege then
  if sqlerrm<>'R2 校验凭据来源不受信任' then raise; end if;
 end;
 begin
  perform public.record_r2_original_receipt(jsonb_set(ctx.proof,'{issued_at}',to_jsonb((ctx.proof->>'issued_at')::bigint-901)));
  raise exception 'Expired receipt accepted';
 exception when invalid_parameter_value then
  if sqlerrm<>'R2 校验凭据已过期，请重新核验' then raise; end if;
 end;
 begin
  perform public.record_r2_original_receipt(jsonb_set(ctx.proof,'{path}',to_jsonb('../unowned.jpg'::text)));
  raise exception 'Unsafe receipt path accepted';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.record_r2_original_receipt(jsonb_set(ctx.proof,'{etag}',to_jsonb(E'fake\nfield'::text)));
  raise exception 'Multiline canonical field accepted';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.record_r2_original_receipt(jsonb_set(ctx.proof,'{bytes}',to_jsonb(1.5)));
  raise exception 'Fractional byte count accepted';
 exception when invalid_parameter_value then null; end;
 begin
  insert into public.artwork_masters(created_by,title,original_filename,mime_type,original_width,original_height,
   original_bytes,sha256,storage_path,storage_provider,storage_origin,verified_sha256,verified_at)
  values(ctx.owner_id,'R2 rollback fixture','fixture.jpg','image/jpeg',10000,4000,62914560,ctx.proof->>'sha256',
   ctx.proof->>'path','r2',ctx.proof->>'storage_origin',ctx.proof->>'sha256',now());
  raise exception 'R2 master was verified without a signed receipt';
 exception when check_violation then
  if sqlerrm<>'R2 原文件没有可信的完整字节校验凭据' then raise; end if;
 end;
 result := public.record_r2_original_receipt(ctx.proof);
 if result->>'verified'<>'true' or (result->>'bytes')::bigint<>62914560 then raise exception 'Valid signed receipt rejected'; end if;
 perform public.record_r2_original_receipt(ctx.proof);
 if not public.verify_r2_original_receipt(ctx.owner_id,ctx.proof->>'path',ctx.proof->>'sha256',62914560,'image/jpeg',ctx.proof->>'storage_origin') then
  raise exception 'Receipt lookup failed';
 end if;
 if public.verify_r2_original_receipt(ctx.owner_id,ctx.proof->>'path',ctx.proof->>'sha256',62914561,'image/jpeg',ctx.proof->>'storage_origin') then
  raise exception 'Incorrect byte count matched receipt';
 end if;
 insert into public.reference_capture_tasks(created_by,source_type,source_id,source_url,title)
 values(ctx.owner_id,'SUHA',ctx.source_id,'https://g2.ltfc.net/view/SUHA/'||ctx.source_id,'R2 rollback fixture') returning id into new_task;
 result := public.register_capture_original(new_task,1,1,'fixture.jpg',ctx.proof->>'sha256','image/jpeg',10000,4000,62914560,
  p_storage_provider=>'r2',p_storage_origin=>ctx.proof->>'storage_origin');
 new_master := (result->>'master_id')::uuid;
 if not exists(select 1 from public.artwork_masters where id=new_master and storage_provider='r2'
  and storage_origin=ctx.proof->>'storage_origin' and original_width=10000 and original_height=4000
  and original_bytes=62914560 and verified_sha256=sha256 and verified_at is not null) then
  raise exception 'R2 mother identity or native geometry not registered';
 end if;
 if not exists(select 1 from public.reference_capture_files where task_id=new_task and phase='complete' and master_id=new_master
  and part_index=1 and expected_count=1 and sha256=ctx.proof->>'sha256') then raise exception 'R2 part association missing'; end if;
 result := public.register_capture_original(new_task,1,1,'fixture.jpg',ctx.proof->>'sha256','image/jpeg',10000,4000,62914560,
  p_storage_provider=>'r2',p_storage_origin=>ctx.proof->>'storage_origin');
 if (result->>'master_id')::uuid<>new_master then raise exception 'Repeated R2 registration created another master'; end if;
 begin
  update public.artwork_masters set original_bytes=original_bytes+1,verified_sha256=sha256,verified_at=now() where id=new_master;
  raise exception 'R2 mother receipt byte guard bypassed';
 exception when check_violation then null; end;
 begin
  update public.artwork_masters set storage_origin='https://other.invalid',verified_sha256=sha256,verified_at=now() where id=new_master;
  raise exception 'R2 mother origin guard bypassed';
 exception when check_violation then null; end;
 update public.artwork_masters set original_width=original_width+1,verified_sha256=sha256,verified_at=now() where id=new_master;
 if exists(select 1 from public.artwork_masters where id=new_master and (verified_sha256 is not null or verified_at is not null)) then
  raise exception 'Changed native geometry retained verification';
 end if;
 update public.artwork_masters set original_width=10000 where id=new_master;
 insert into public.artwork_crops(master_id,x,y,w,h,title,category_id,status)
 values(new_master,20,30,100,200,'R2 rollback crop',(select id from public.categories order by id limit 1),'draft') returning id into new_crop;
 begin
  perform public.publish_artwork_crop(new_crop);
  raise exception 'Unverified R2 mother was published';
 exception when raise_exception then
  if sqlerrm<>'R2 高清母图尚未通过完整字节校验，不能发布' then raise; end if;
 end;
 update public.artwork_masters set verified_sha256=sha256,verified_at=now() where id=new_master;
 new_ref := public.publish_artwork_crop(new_crop);
 if not exists(select 1 from public.references where id=new_ref and image_url=(ctx.proof->>'storage_origin')||'/public/'||(ctx.proof->>'path')
  and highres_url=image_url and crop_x=20::float8/10000 and crop_y=30::float8/4000
  and crop_w=100::float8/10000 and crop_h=200::float8/4000) then
  raise exception 'R2 publication URL or native-coordinate mapping wrong';
 end if;
 update r2_test_context set task_id=new_task,master_id=new_master,crop_id=new_crop,reference_id=new_ref;
end; $$;

-- Existing Supabase RPC calls omit the new defaults and retain the same IDs/part count.
do $$
declare f public.reference_capture_files; m public.artwork_masters; result jsonb;
begin
 select files.* into f from public.reference_capture_files files
 join public.artwork_masters masters on masters.id=files.master_id and masters.storage_provider='supabase'
 join public.reference_capture_tasks tasks on tasks.id=files.task_id and not tasks.paused
 join storage.objects o on o.bucket_id='art-reference-images' and o.name=masters.storage_path
 where files.created_by=auth.uid() and files.phase='complete' and (o.metadata->>'size')::bigint=masters.original_bytes
 order by files.updated_at limit 1;
 if found then
  select * into strict m from public.artwork_masters where id=f.master_id;
  result := public.register_capture_original(f.task_id,f.part_index,f.expected_count,m.original_filename,
   m.sha256,m.mime_type,m.original_width,m.original_height,m.original_bytes);
  if (result->>'master_id')::uuid<>m.id or (result->>'project_id')::uuid<>m.project_id then raise exception 'Existing Supabase IDs changed'; end if;
 end if;
end; $$;

reset role;
update original_storage_private.config set enabled=false where singleton;
set local role authenticated;
do $$
declare ctx r2_test_context; config jsonb;
begin
 select * into strict ctx from r2_test_context;
 config:=public.get_original_storage_config();
 if config->>'provider'<>'supabase' or (config->>'enabled')::boolean is not false
  or config->>'endpoint'<>'https://r2-rollback-test.invalid' or config->'readOrigins'<>'["https://r2-rollback-test.invalid"]'::jsonb then
  raise exception 'Disabling uploads lost trusted R2 read origin';
 end if;
 if not public.verify_r2_original_receipt(ctx.owner_id,ctx.proof->>'path',ctx.proof->>'sha256',62914560,'image/jpeg',ctx.proof->>'storage_origin') then
  raise exception 'Disabling uploads made existing R2 receipt unreadable';
 end if;
 begin
  perform public.record_r2_original_receipt(ctx.proof);
  raise exception 'Disabled R2 accepted a new receipt';
 exception when object_not_in_prerequisite_state then null; end;
end; $$;
select set_config('request.jwt.claim.sub',(select other_owner::text from r2_test_context),true);
do $$
declare ctx r2_test_context;
begin
 select * into strict ctx from r2_test_context;
 if exists(select 1 from public.artwork_masters where id=ctx.master_id)
  or exists(select 1 from public.reference_capture_files where task_id=ctx.task_id) then raise exception 'Cross-account R2 metadata exposed'; end if;
 begin
  perform public.verify_r2_original_receipt(ctx.owner_id,ctx.proof->>'path',ctx.proof->>'sha256',62914560,'image/jpeg',ctx.proof->>'storage_origin');
  raise exception 'Cross-owner R2 proof exposed';
 exception when insufficient_privilege then null; end;
end; $$;
reset role;
do $$ begin
 if exists(select 1 from r2_test_existing_masters old left join public.artwork_masters current on current.id=old.id
  where current.id is null or (current.sha256,current.original_width,current.original_height,current.original_bytes,current.storage_path,
        current.project_id,current.status,current.storage_provider,current.storage_origin)
    is distinct from (old.sha256,old.original_width,old.original_height,old.original_bytes,old.storage_path,
        old.project_id,old.status,old.storage_provider,old.storage_origin)) then
  raise exception 'Existing mother identity, bytes, geometry, location or project changed';
 end if;
 if exists(select 1 from r2_test_existing_crops old left join public.artwork_crops current on current.id=old.id
  where current.id is null or to_jsonb(current) is distinct from to_jsonb(old)) then raise exception 'Existing draft or published crop changed'; end if;
 if exists(select 1 from r2_test_existing_files old left join public.reference_capture_files current on current.id=old.id
  where current.id is null or (current.task_id,current.part_index,current.expected_count,current.phase,current.sha256,current.master_id)
   is distinct from (old.task_id,old.part_index,old.expected_count,old.phase,old.sha256,old.master_id)) then
  raise exception 'Existing capture part progress changed';
 end if;
end; $$;
select 'R2 HMAC/owner/origin/time/path/type guards, protected tables, >50 MiB registration, draft publication, native geometry, disabled-read behavior, existing identities and owner RLS passed; all fixtures rolled back' as result;
rollback;
