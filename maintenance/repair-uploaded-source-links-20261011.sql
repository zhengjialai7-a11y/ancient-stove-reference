-- Correct sources verified against the original LTFC page titles and uploaded filenames.
-- Metadata only: original bytes, hashes, verification receipts, crops and references stay intact.
begin;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"f2e668a6-d31d-4468-8319-a87291f6fe2f","role":"authenticated"}',true);
do $$
declare
 link record; n integer; rare_project uuid;
 frozen_before jsonb; frozen_after jsonb; crops_before integer; refs_before integer;
 old_source constant text := 'https://g2.ltfc.net/view/SUHA/61801f6cd7eb144471493e48';
begin
 select jsonb_agg(jsonb_build_array(id,storage_path,sha256,original_bytes,original_width,original_height,original_filename,verified_sha256,verified_at) order by id) into frozen_before from public.artwork_masters;
 select count(*) into crops_before from public.artwork_crops;
 select count(*) into refs_before from public.references;
 for link in select * from (values
  ('0c56870b-b11e-446e-8125-4a90deaf0af2'::uuid,'地狱绘卷.棠洲安政2年原画','609678a9e2d4222ecd8c2d24','日本_佚名日本人_地狱绘卷.棠洲安政2年原画_%',19),
  ('6f3c07d4-5ddb-42f4-9b2a-f71fbc8a5e77'::uuid,'百鹊图卷','608a61b2aa7c385c8d9448d5','清_查士标_百鹊图卷_%',1),
  ('2c2320a8-b68a-45c9-961c-f519873e588b'::uuid,'罗汉图','608a623142b4355c93c903e6','元_蔡山_罗汉图_%',1)
 ) as links(project,title,source_id,filename_pattern,expected_masters) loop
  update public.artwork_projects set source_url='https://g2.ltfc.net/view/SUHA/'||link.source_id
  where id=link.project and title=link.title and created_by=(select auth.uid())
   and source_url in(old_source,'https://g2.ltfc.net/view/SUHA/'||link.source_id);
  get diagnostics n=row_count;
  if n<>1 then raise exception 'Project changed or unavailable: %',link.title; end if;
  update public.artwork_masters set source_url='https://g2.ltfc.net/view/SUHA/'||link.source_id
  where project_id=link.project and created_by=(select auth.uid()) and title=link.title
   and original_filename like link.filename_pattern
   and source_url in(old_source,'https://g2.ltfc.net/view/SUHA/'||link.source_id);
  get diagnostics n=row_count;
  if n<>link.expected_masters then raise exception 'Unexpected original-file set: % (%)',link.title,n; end if;
  update public.reference_capture_tasks t set project_id=p.id,title=p.title,author=coalesce(p.author,''),era=coalesce(p.era,''),updated_at=now()
  from public.artwork_projects p where p.id=link.project and t.created_by=(select auth.uid())
   and t.source_type='SUHA' and t.source_id=link.source_id and (t.project_id is null or t.project_id=p.id);
  get diagnostics n=row_count;
  if n<>1 then raise exception 'Collection task changed or unavailable: %',link.title; end if;
 end loop;
 -- The old shared link is actually 珍禽货郎图. Give its misplaced original an independent project.
 if (select count(*) from public.artwork_projects where created_by=(select auth.uid()) and source_url=old_source)>1 then
  raise exception 'Old source still ambiguous';
 end if;
 select id into rare_project from public.artwork_projects where created_by=(select auth.uid()) and source_url=old_source and title='珍禽货郎图';
 if rare_project is null then
  insert into public.artwork_projects(created_by,title,author,era,source_url)
  values((select auth.uid()),'珍禽货郎图','佚名明人','明',old_source) returning id into rare_project;
 end if;
 update public.artwork_masters set project_id=rare_project,title='珍禽货郎图',author='佚名明人',era='明',source_url=old_source,part_index=1
 where id='ead94e80-0d93-4aa2-b31c-89af96542c36' and created_by=(select auth.uid())
  and project_id in('2c2320a8-b68a-45c9-961c-f519873e588b'::uuid,rare_project)
  and original_filename='明_佚名明人_珍禽货郎图_1.jpg' and source_url=old_source;
 get diagnostics n=row_count;
 if n<>1 then raise exception 'Misplaced master changed or unavailable'; end if;
 update public.reference_capture_tasks set project_id=rare_project,title='珍禽货郎图',author='佚名明人',era='明',updated_at=now()
 where source_type='SUHA' and source_id='61801f6cd7eb144471493e48' and created_by=(select auth.uid()) and (project_id is null or project_id=rare_project);
 get diagnostics n=row_count;
 if n<>1 then raise exception 'Rare-bird collection task changed or unavailable'; end if;
 for link in select * from (values
  ('609678a9e2d4222ecd8c2d24',19),('608a61b2aa7c385c8d9448d5',1),('608a623142b4355c93c903e6',1),('61801f6cd7eb144471493e48',1)
 ) as expected(source_id,master_count) loop
  if not exists(select 1 from public.reference_capture_status s where s.source_type='SUHA' and s.source_id=link.source_id and s.master_count=link.master_count and s.candidate_count=1 and s.live_status='uploaded_unverified') then
   raise exception 'Queue association failed for %',link.source_id;
  end if;
 end loop;
 select jsonb_agg(jsonb_build_array(id,storage_path,sha256,original_bytes,original_width,original_height,original_filename,verified_sha256,verified_at) order by id) into frozen_after from public.artwork_masters;
 if frozen_before is distinct from frozen_after then raise exception 'Original file or verification receipt changed'; end if;
 if crops_before<>(select count(*) from public.artwork_crops) or refs_before<>(select count(*) from public.references) then raise exception 'Crop or reference count changed'; end if;
end $$;
select display_title,source_id,master_count,verified_count,draft_count,published_count,candidate_count,live_status
from public.reference_capture_status where source_id in ('609678a9e2d4222ecd8c2d24','608a61b2aa7c385c8d9448d5','608a623142b4355c93c903e6','61801f6cd7eb144471493e48') order by queue_order;
commit;
