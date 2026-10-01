import { DataSource } from 'typeorm';
import { createE2EHarness, E2EHarness } from './setup';
import { ConfigService } from '../../src/config/config.service';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { WorkspaceService } from '../../src/workspaces/workspace.service';
import { WorkspaceMembershipService } from '../../src/auth/workspace-membership.service';
import { book, rate, tokenBook } from '../unit/pricing-fixtures';
const base='/api/dashboard/pricing';
describe('pricing metering governance HTTP',()=>{
 let h:E2EHarness,db:DataSource;
 beforeEach(async()=>{h=await createE2EHarness();await h.app.get(PricingRecoveryService).onModuleDestroy();db=h.app.get(DataSource);await applyPricingSchema(db)});
 afterEach(async()=>{await h?.close()});
 const create=async(content=tokenBook())=>(await h.agent.post(base+'/books').send({name:'Synthetic metering review',scope:'workspace',content})).body;
 const options=(operation='chat_completions')=>({draft_revision:1,catalog_revision:0,reason:'Synthetic review',confirm:true,targets:[{level:'node',node_id:'mock-openai',model:'gpt-4o',operation}]});
 it('previews conditional capabilities without writes or provider calls, then audits the reviewed hash',async()=>{
  const created=await create();const before=await db.query('SELECT * FROM pricing_audit_events');const preview=await h.agent.post(`${base}/drafts/${created.draft.id}/preview-publication`).send(options());expect(preview.status).toBe(201);expect(preview.body.metering).toMatchObject({can_publish:true,quantity_limits_verified:false,supplier_support_verified:false});expect(await db.query('SELECT * FROM pricing_audit_events')).toEqual(before);const published=await h.agent.post(`${base}/drafts/${created.draft.id}/publish`).send({...options(),metering_assessment_hash:preview.body.metering.assessment_hash});expect(published.status).toBe(201);expect(published.body.metering.assessment_hash).toBe(preview.body.metering.assessment_hash);expect(h.fetchMock.calls).toHaveLength(0);
 });
 it('does not activate an unintegrated Live protocol and returns a stable error',async()=>{
  const created=await create(book([rate('session','session_seconds','1','1')]));const preview=await h.agent.post(`${base}/drafts/${created.draft.id}/preview-publication`).send(options('unimplemented_live'));expect(preview.status).toBe(201);expect(preview.body.metering.can_publish).toBe(false);const rejected=await h.agent.post(`${base}/drafts/${created.draft.id}/publish`).send(options('unimplemented_live'));expect(rejected.status).toBe(400);expect(rejected.body.error.code).toBe('pricing_metering_unsupported');expect((await h.agent.get(base+'/bindings')).body.head.revision).toBe(0);expect(h.fetchMock.calls).toHaveLength(0);
 });
 it('rejects changed native profile and malformed review hashes without publishing',async()=>{
  const created=await create(book([rate('seconds','video_seconds','1','1')]));const body=options('video_generation');const preview=await h.agent.post(`${base}/drafts/${created.draft.id}/preview-publication`).send(body);h.app.get(ConfigService).getNode('mock-openai')!.video_result_profile='runway-task-v1';const rejected=await h.agent.post(`${base}/drafts/${created.draft.id}/publish`).send({...body,metering_assessment_hash:preview.body.metering.assessment_hash});expect(rejected.status).toBe(409);expect((await h.agent.post(`${base}/drafts/${created.draft.id}/publish`).send({...body,metering_assessment_hash:'not-a-hash'})).status).toBe(400);expect((await h.agent.get(base+'/bindings')).body.head.revision).toBe(0);
 });
 it('protects preview scope and exposes no credentials through node profile assessment',async()=>{
  const created=await create();const result=await h.agent.post(`${base}/drafts/${created.draft.id}/preview-publication`).send(options());expect(result.status).toBe(201);expect(JSON.stringify(result.body.metering)).not.toMatch(/api_key|base_url|headers|credential/);const ws=await h.app.get(WorkspaceService).createWorkspace({name:'Other'});await h.app.get(WorkspaceMembershipService).ensureMembership({userId:'dashboard',workspaceId:ws.id,organizationId:ws.organization_id,role:'viewer'});const foreign=await h.agent.post(`${base}/drafts/${created.draft.id}/preview-publication`).set('x-siftgate-workspace-id',ws.id).send(options());expect([403,404]).toContain(foreign.status);
 });
});
