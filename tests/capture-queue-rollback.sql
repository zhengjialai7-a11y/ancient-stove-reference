-- Exercises live aggregation and actual owner RLS. All fixtures are rolled back.
begin;
select set_config('request.jwt.claim.sub','f2e668a6-d31d-4468-8319-a87291f6fe2f',true);
set local role authenticated;
do $$
declare p uuid; p2 uuid; t uuid; m1 uuid; m2 uuid; c uuid; cat uuid; r record; n int;
begin
 select count(*) into n from public.reference_capture_tasks;
 if n<718 then raise exception 'Owner queue visibility failed'; end if;
 insert into public.artwork_projects(created_by,title,source_url) values(auth.uid(),'queue-test','https://g2.ltfc.net/view/SUHA/ffffffffffffffffffffff01') returning id into p;
 insert into public.reference_capture_tasks(created_by,source_type,source_id,title) values(auth.uid(),'SUHA','ffffffffffffffffffffff01','queue-test') returning id into t;
 insert into public.reference_capture_tasks(created_by,source_type,source_id) values(auth.uid(),'SUHA','ffffffffffffffffffffff01') on conflict(created_by,source_type,source_id) do nothing;
 select count(*) into n from public.reference_capture_tasks where source_id='ffffffffffffffffffffff01';
 if n<>1 then raise exception 'Deduplication failed'; end if;
 insert into public.artwork_masters(created_by,project_id,title,original_filename,mime_type,original_width,original_height,original_bytes,sha256,storage_path)
 values(auth.uid(),p,'queue-test','one.jpg','image/jpeg',100,100,100,repeat('a',64),'tests/queue-one') returning id into m1;
 insert into public.artwork_masters(created_by,project_id,title,original_filename,mime_type,original_width,original_height,original_bytes,sha256,storage_path,verified_sha256,verified_at)
 values(auth.uid(),p,'queue-test','two.jpg','image/jpeg',100,100,100,repeat('b',64),'tests/queue-two',repeat('b',64),now()) returning id into m2;
 select * into r from public.reference_capture_status where id=t;
 if r.master_count<>2 or r.verified_count<>1 or r.resolved_project_id<>p or r.live_status<>'uploaded_unverified' then raise exception 'Multipart aggregation failed'; end if;
 begin
 update public.artwork_masters set verified_at=now() where id=m1;
 raise exception 'Incomplete receipt accepted';
 exception when check_violation then null; end;
 update public.artwork_masters set verified_sha256=sha256,verified_at=now() where id=m1;
 select * into r from public.reference_capture_status where id=t;
 if r.live_status<>'uploaded' or r.verified_count<>2 then raise exception 'Upload verification state failed'; end if;
 select id into cat from public.categories limit 1;
 insert into public.artwork_crops(master_id,title,category_id,x,y,w,h) values(m1,'queue-test',cat,0,0,10,10) returning id into c;
 select * into r from public.reference_capture_status where id=t;
 if r.live_status<>'drafts_ready' or r.draft_count<>1 then raise exception 'Draft status failed'; end if;
 update public.artwork_crops set status='published' where id=c;
 select * into r from public.reference_capture_status where id=t;
 if r.live_status<>'published' or r.published_count<>1 then raise exception 'Published status failed'; end if;
 update public.reference_capture_tasks set paused=true where id=t;
 select * into r from public.reference_capture_status where id=t;
 if not r.paused or r.master_count<>2 then raise exception 'Pause lost progress'; end if;
 update public.reference_capture_tasks set paused=false where id=t;
 insert into public.reference_capture_tasks(created_by,source_type,source_id,title) values(auth.uid(),'SUHA','ffffffffffffffffffffff02','queue-test');
 select * into r from public.reference_capture_status where source_id='ffffffffffffffffffffff02';
 if r.master_count<>0 then raise exception 'Same title linked different version'; end if;
 insert into public.artwork_projects(created_by,title,source_url) values(auth.uid(),'different-version','https://g2.ltfc.net/view/SUHA/ffffffffffffffffffffff01') returning id into p2;
 select * into r from public.reference_capture_status where id=t;
 if r.live_status<>'needs_review' or r.master_count<>0 then raise exception 'Ambiguous source auto-linked'; end if;
 update public.reference_capture_tasks set project_id=p where id=t;
 select * into r from public.reference_capture_status where id=t;
 if r.master_count<>2 then raise exception 'Explicit project association failed'; end if;
 update public.artwork_masters set storage_path='tests/changed-object' where id=m1;
 select * into r from public.reference_capture_status where id=t;
 if r.verified_count<>1 then raise exception 'Changed object retained old receipt'; end if;
end; $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
do $$ begin
 if exists(select 1 from public.reference_capture_status) then raise exception 'Cross-user queue data exposed'; end if;
 if exists(select 1 from public.reference_capture_tasks) then raise exception 'Cross-user tasks exposed'; end if;
end; $$;
rollback;
