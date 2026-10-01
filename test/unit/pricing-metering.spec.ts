import { DataSource } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessPricingMetering, meteringAvailability } from '../../src/pricing/pricing-metering';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import { PRICING_ADMISSION_OPERATIONS } from '../../src/pricing/pricing-admission.types';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import type { ConfigService } from '../../src/config/config.service';
import type { VideoResultProfile } from '../../src/pricing/video-result-profile.types';
import { translateNativeVideoResult } from '../../src/pricing/video-result-profile';
import { book, rate, tokenBook } from './pricing-fixtures';
const target = {level:'model' as const,model:'synthetic-model'};

describe('metering inventory matches extraction boundaries, not supplier marketing',()=>{
 it('keeps provider counters conditional for every integrated operation',()=>{
  for(const operation of PRICING_ADMISSION_OPERATIONS){expect(meteringAvailability(operation,'uncached_input_tokens')).toBe('conditional');expect(meteringAvailability(operation,'request_count')).toBe('local_measurement')}
  const content=tokenBook(),before=JSON.stringify(content),review=assessPricingMetering(content,[target]);expect(review.can_publish).toBe(true);expect(review.supplier_support_verified).toBe(false);expect(review.quantity_limits_verified).toBe(false);expect(review.targets[0].notices).toContain('operation_unspecified');expect(JSON.stringify(content)).toBe(before);
  const{assessment_hash,...body}=review;expect(assessment_hash).toBe(pricingContentHash(body));
 });
 it('refuses unintegrated protocols and impossible mixed bases rather than advertising support',()=>{
  expect(assessPricingMetering(book([rate('session','session_seconds','1','1')]),[{...target,operation:'unimplemented_live'}]).can_publish).toBe(false); expect(assessPricingMetering(book([rate('session','session_seconds','1','1')]),[{...target,operation:'realtime'}]).targets[0].notices).toContain('realtime_session_contract_required');
  expect(assessPricingMetering(tokenBook(),[{...target,operation:'unimplemented_live'}]).targets[0].notices).toContain('operation_unsupported');
  const incompatible=book([rate('images','image_count','1','1'),rate('seconds','video_seconds','1','1')]);incompatible.allow_combined_media=true;expect(assessPricingMetering(incompatible,[target]).can_publish).toBe(false);
 });
 it('advertises only integrated raw chat subsets, without promising every native protocol or model',()=>{
  for(const operation of ['chat_completions','responses','messages']) { expect(meteringAvailability(operation,'audio_output_tokens')).toBe('conditional'); expect(meteringAvailability(operation,'uncached_audio_input_tokens')).toBe('conditional'); expect(meteringAvailability(operation,'image_output_tokens')).toBe('conditional'); } expect(meteringAvailability('embeddings','audio_output_tokens')).toBe('unsupported'); expect(meteringAvailability('gemini_generate_content','audio_output_tokens')).toBe('unsupported');expect(meteringAvailability('audio_speech','audio_output_tokens')).toBe('conditional');expect(meteringAvailability('audio_speech','requested_audio_output_seconds')).toBe('request_metadata');expect(meteringAvailability('audio_speech','text_characters')).toBe('request_metadata');
 });
 it('matches native translators that report count but explicitly lack actual seconds',()=>{
  for(const profile of ['runway-task-v1','gemini-veo-rest-v1'] as const){const body=profile==='runway-task-v1'?{id:'123e4567-e89b-42d3-a456-426614174000',status:'SUCCEEDED',output:['https://example.test/result']}:{name:'operations/test',done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:'gs://synthetic/result'}}]}}};const actual=translateNativeVideoResult(profile,body);expect(actual.usage.quantities.video_seconds?.quality).toBe('unsupported');expect(actual.usage.quantities.video_generation_count?.value).toBe('1');expect(meteringAvailability('video_generation','video_seconds',profile)).toBe('manual_only');expect(meteringAvailability('video_generation','video_generation_count',profile)).toBe('conditional');expect(meteringAvailability('video_generation','requested_video_seconds',profile)).toBe('request_metadata')}
 });
 it('requires supplier and timestamp review without inventing hard limits or service support',()=>{
  const content=tokenBook();content.time_basis='provider_accepted_at';content.groups[0].rules[0].condition.service_tiers=['priority','flex'];const review=assessPricingMetering(content,[{...target,operation:'responses'}]);expect(review.targets[0].notices).toEqual(expect.arrayContaining(['supplier_contract_required','timestamp_contract_required','limits_not_verified','model_support_unverified']));
 });
 it('pins selected profile identity in the review hash and keeps generic model scope unverified',()=>{
  const content=book([rate('video','video_seconds','1','1')]);const targets=[{...target,level:'node' as const,node_id:'n',operation:'video_generation'}];const generic=assessPricingMetering(content,targets,()=> 'generic-v1'),native=assessPricingMetering(content,targets,()=> 'runway-task-v1');expect(generic.assessment_hash).not.toBe(native.assessment_hash);expect(native.targets[0].notices).toContain('manual_evidence_required');expect(assessPricingMetering(content,[target]).targets[0].notices).toContain('video_profile_unspecified');
 });
});
function contract(label:string,connect:()=>Promise<{db:DataSource;cleanup:()=>Promise<void>}>,run=describe){run(label,()=>{
 let db:DataSource,cleanup:()=>Promise<void>,repo:PricingRepository,profile:VideoResultProfile;
 const actor={id:'admin',workspace_id:'w',role:'admin' as const,global_admin:true};
 const options={draft_revision:1,catalog_revision:0,confirm:true as const,reason:'Synthetic metering review',targets:[{...target,level:'node' as const,node_id:'n',operation:'video_generation'}]};
 beforeEach(async()=>{({db,cleanup}=await connect());await applyPricingSchema(db);profile='generic-v1';repo=new PricingRepository(db,{get nodes(){return [{id:'n',video_result_profile:profile}]}} as ConfigService)});
 afterEach(async()=>{if(db?.isInitialized)await db.destroy();await cleanup?.()});
 it('rejects impossible publication atomically while preview remains read-only',async()=>{
  const created=await repo.createBook(actor,{name:'Synthetic',scope:'workspace',content:book([rate('image','image_count','1','1')])});const before=await db.query('SELECT * FROM pricing_audit_events');const preview=await repo.previewPublish(actor,created.draft.id,options);expect(preview.metering.can_publish).toBe(false);expect(await db.query('SELECT * FROM pricing_audit_events')).toEqual(before);await expect(repo.publishDraft(actor,created.draft.id,options)).rejects.toMatchObject({code:'pricing_metering_unsupported',status:400});expect((await repo.listBindings(actor)).head.revision).toBe(0);expect(await db.query('SELECT * FROM pricing_audit_events')).toEqual(before);
 });
 it('rejects profile changes after review and retains draft and catalog until fresh confirmation',async()=>{
  const created=await repo.createBook(actor,{name:'Synthetic',scope:'workspace',content:book([rate('video','video_seconds','1','1')])});const preview=await repo.previewPublish(actor,created.draft.id,options);profile='runway-task-v1';await expect(repo.publishDraft(actor,created.draft.id,{...options,metering_assessment_hash:preview.metering.assessment_hash})).rejects.toMatchObject({status:409});expect((await repo.getDraft(actor,created.draft.id)).revision).toBe(1);expect((await repo.listBindings(actor)).head.revision).toBe(0);
  const current=await repo.previewPublish(actor,created.draft.id,options);expect(current.metering.targets[0].dimensions[0].availability).toBe('manual_only');const published=await repo.publishDraft(actor,created.draft.id,{...options,metering_assessment_hash:current.metering.assessment_hash});expect(published.metering.assessment_hash).toBe(current.metering.assessment_hash);const events=await db.query("SELECT metadata_json FROM pricing_audit_events WHERE action = 'draft.published'");expect(JSON.parse(events[0].metadata_json)).toMatchObject({metering_review_confirmed:true,metering:{quantity_limits_verified:false,supplier_support_verified:false}});
 });
 it('rechecks metering on rollback without rewriting earlier audit evidence',async()=>{
  const created=await repo.createBook(actor,{name:'Synthetic',scope:'workspace',content:book([rate('video','video_seconds','1','1')])});const published=await repo.publishDraft(actor,created.draft.id,options);const old=await db.query("SELECT * FROM pricing_audit_events WHERE action = 'draft.published'");const opts={...options,catalog_revision:1};const preview=await repo.previewRollback(actor,created.book.id,published.version_id,opts);profile='gemini-veo-rest-v1';await expect(repo.rollback(actor,created.book.id,published.version_id,{...opts,metering_assessment_hash:preview.metering.assessment_hash})).rejects.toMatchObject({status:409});expect(await db.query("SELECT * FROM pricing_audit_events WHERE action = 'draft.published'")).toEqual(old);
 });
})}
contract('SQLite metering publication',async()=>{const dir=mkdtempSync(join(tmpdir(),'metering-'));const db=await new DataSource({type:'better-sqlite3',database:join(dir,'test.db'),synchronize:false,entities:[]}).initialize();return {db,cleanup:async()=>rmSync(dir,{recursive:true,force:true})}});
const url=process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;if(url&&(new URL(url).hostname!=='127.0.0.1'||!/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(url).pathname)))throw Error('Private PostgreSQL required');
contract('PostgreSQL metering publication',async()=>{if(!url)throw Error('Private PG required');const schema=`metering_${process.pid}_${Math.random().toString(16).slice(2)}`,admin=await new DataSource({type:'postgres',url,synchronize:false}).initialize();await admin.query(`CREATE SCHEMA "${schema}"`);const db=await new DataSource({type:'postgres',url,schema,extra:{options:`-c search_path=${schema}`},synchronize:false,entities:[]}).initialize();return {db,cleanup:async()=>{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.destroy()}}},url?describe:describe.skip);
