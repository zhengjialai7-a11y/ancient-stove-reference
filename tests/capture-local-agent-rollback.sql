-- Uses an existing stored original; every metadata/ledger change is rolled back.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','f2e668a6-d31d-4468-8319-a87291f6fe2f',true);
do $$
declare t public.reference_capture_tasks; m public.artwork_masters; result jsonb; before_count integer;
begin
 select * into strict t from public.reference_capture_tasks where source_id='608a623142b4355c93c90362' and source_type='SUHA';
 select * into strict m from public.artwork_masters where project_id=(select resolved_project_id from public.reference_capture_status where id=t.id) limit 1;
 select count(*) into before_count from public.artwork_masters;
 result:=public.register_capture_original(t.id,1,1,m.original_filename,m.sha256,m.mime_type,m.original_width,m.original_height,m.original_bytes);
 if (result->>'master_id')::uuid<>m.id or (result->>'project_id')::uuid<>m.project_id then raise exception 'Existing original identity changed'; end if;
 if (select count(*) from public.artwork_masters)<>before_count then raise exception 'Duplicate mother created'; end if;
 if not exists(select 1 from public.reference_capture_files where task_id=t.id and part_index=1 and expected_count=1 and phase='complete' and master_id=m.id and sha256=m.sha256) then raise exception 'Part association missing'; end if;
 perform public.register_capture_original(t.id,1,1,m.original_filename,m.sha256,m.mime_type,m.original_width,m.original_height,m.original_bytes);
 if (select count(*) from public.reference_capture_files where task_id=t.id)<>1 then raise exception 'Duplicate ledger row'; end if;
 begin
  perform public.register_capture_original(t.id,1,1,m.original_filename,m.sha256,m.mime_type,m.original_width,m.original_height,m.original_bytes+1);
  raise exception 'Wrong bytes accepted';
 exception when raise_exception then if sqlerrm<>'云端原文件不存在或字节数不匹配' then raise; end if; end;
 begin
  perform public.register_capture_original(t.id,2,2,m.original_filename,m.sha256,m.mime_type,m.original_width,m.original_height,m.original_bytes);
  raise exception 'Changed count accepted';
 exception when raise_exception then if sqlerrm<>'母图总张数与已有分段记录不一致' then raise; end if; end;
 update public.reference_capture_tasks set paused=true where id=t.id;
 begin
  perform public.register_capture_original(t.id,1,1,m.original_filename,m.sha256,m.mime_type,m.original_width,m.original_height,m.original_bytes);
  raise exception 'Paused task accepted';
 exception when raise_exception then if sqlerrm<>'收藏任务已暂停' then raise; end if; end;
end; $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
do $$ begin
 if exists(select 1 from public.reference_capture_files) then raise exception 'Cross-account ledger exposed'; end if;
 if has_function_privilege('anon','public.register_capture_original(uuid,integer,integer,text,text,text,integer,integer,bigint,text,text,text)','EXECUTE') then raise exception 'Anonymous registration exposed'; end if;
end; $$;
select 'Original reuse, exact Storage bytes, per-part identity, repeated registration, count guard, pause guard and owner RLS passed' as result;
rollback;
