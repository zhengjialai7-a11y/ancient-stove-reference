-- Real RPC/owner RLS checks. Fixtures and archives are rolled back.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','f2e668a6-d31d-4468-8319-a87291f6fe2f',true);
do $$
declare fixture_json jsonb; first_result jsonb; repeated jsonb; expanded jsonb; original_hash text; after_hash text;
 saved_row public.reference_capture_tasks; archive_count integer; max_order integer; ids uuid[];
begin
 if exists(select 1 from public.reference_capture_tasks where source_id in ('ffffffffffffffffffffee01','ffffffffffffffffffffee02')) then raise exception 'Fixture identity already exists'; end if;
 select * into strict saved_row from public.reference_capture_tasks where project_id is not null order by id limit 1;
 select md5(jsonb_agg(to_jsonb(t) order by id)::text),max(queue_order) into original_hash,max_order from public.reference_capture_tasks t;
 fixture_json := jsonb_build_object('albumId','test-only','items',jsonb_build_array(
  jsonb_build_object('sourceId',saved_row.source_id,'sourceType',saved_row.source_type,'title','MUST NOT OVERWRITE','notes','MUST NOT OVERWRITE','paused',true,'phase','failed','project_id',null),
  jsonb_build_object('sourceId','FFFFFFFFFFFFFFFFFFFFEE01','sourceType','suha','title','same-title','status','uploaded','verified_sha256',repeat('a',64)),
  jsonb_build_object('resource',jsonb_build_object('id','ffffffffffffffffffffee01','type','SUHA'),'title','duplicate'),
  jsonb_build_object('source_id','ffffffffffffffffffffee01','source_type','SHIY','title','same-title'),
  null,42,jsonb_build_object('sourceId','invalid','sourceType','SUHA')));
 first_result := public.import_reference_capture_json(fixture_json,'增量实测.json');
 if (first_result->>'added_count')::int<>2 or (first_result->>'existing_count')::int<>1 or (first_result->>'duplicate_count')::int<>1 or (first_result->>'invalid_count')::int<>3 then raise exception 'Incorrect initial counts: %',first_result; end if;
 select md5(jsonb_agg(to_jsonb(t) order by id)::text) into after_hash from public.reference_capture_tasks t where source_id<>'ffffffffffffffffffffee01';
 if original_hash<>after_hash then raise exception 'Existing metadata/progress/project links changed'; end if;
 select array_agg(id order by queue_order) into ids from public.reference_capture_tasks where source_id='ffffffffffffffffffffee01';
 if to_jsonb(ids)<>first_result->'new_task_ids' then raise exception 'New task IDs are inaccurate'; end if;
 if not exists(select 1 from public.reference_capture_tasks where id=ids[1] and queue_order=max_order+1 and phase='pending' and project_id is null) then raise exception 'New rows reordered queue or trusted fake upload state'; end if;
 if not exists(select 1 from public.reference_capture_tasks where id=ids[2] and queue_order=max_order+2 and phase='needs_review' and source_url is null) then raise exception 'Source type/version distinction lost'; end if;
 if not exists(select 1 from public.reference_capture_imports where id=(first_result->>'id')::uuid and payload=fixture_json and file_name='增量实测.json' and new_task_ids=ids) then raise exception 'Original JSON archive missing'; end if;
 repeated := public.import_reference_capture_json(fixture_json,'renamed.json');
 if repeated->>'id'<>first_result->>'id' or (repeated->>'added_count')::int<>0 or (repeated->>'existing_count')::int<>3 or repeated->'new_task_ids'<>'[]'::jsonb or repeated->'reused_archive'<>'true'::jsonb then raise exception 'Repeated file is not idempotent: %',repeated; end if;
 expanded := public.import_reference_capture_json(jsonb_build_object('observedFavorites',jsonb_build_object('rows',fixture_json->'items'||jsonb_build_array(jsonb_build_object('sourceId','ffffffffffffffffffffee02','sourceType','SUHA','title','same-title')))),'新收藏清单.json');
 if (expanded->>'added_count')::int<>1 or (expanded->>'existing_count')::int<>3 or jsonb_array_length(expanded->'new_task_ids')<>1 then raise exception 'Expanded collection was not incremental: %',expanded; end if;
 select count(*) into archive_count from public.reference_capture_imports;
 begin
  perform public.import_reference_capture_json('{"items":[null,{"title":"no identity"}]}'::jsonb);
  raise exception 'Invalid-only JSON accepted';
 exception when raise_exception then if sqlerrm<>'未找到有效来源作品 ID' then raise; end if; end;
 begin
  perform public.import_reference_capture_json(jsonb_build_object('items',fixture_json->'items','oversized',repeat('x',8388608)));
  raise exception 'Oversize JSON accepted';
 exception when raise_exception then if sqlerrm<>'收藏 JSON 不能超过 8MB' then raise; end if; end;
 if (select count(*) from public.reference_capture_imports)<>archive_count then raise exception 'Rejected import left partial archive'; end if;
end; $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
do $$ begin
 if exists(select 1 from public.reference_capture_imports) then raise exception 'Cross-account archives exposed'; end if;
 if exists(select 1 from public.reference_capture_tasks) then raise exception 'Cross-account tasks exposed'; end if;
 begin
  insert into public.reference_capture_imports(created_by,file_name,payload,content_sha256,item_count,added_count,existing_count,invalid_count,duplicate_count)
  values('f2e668a6-d31d-4468-8319-a87291f6fe2f','forged','{}',repeat('f',64),1,0,1,0,0);
  raise exception 'Cross-account archive insertion accepted';
 exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
 begin
  perform public.import_reference_capture_json('[]'::jsonb);
  raise exception 'Import without session accepted';
 exception when insufficient_privilege then null; end;
 if has_function_privilege('anon','public.import_reference_capture_json(jsonb,text)','EXECUTE') then raise exception 'Anonymous import exposed'; end if;
end; $$;
select 'Incremental RPC, immutable progress, full JSON archive, repeat deduplication, version identity, rejection rollback and owner RLS passed' as result;
rollback;
