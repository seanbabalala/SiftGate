import { DataSource } from 'typeorm';
import { createE2EHarness, E2EHarness } from './setup';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import { WorkspaceService } from '../../src/workspaces/workspace.service';
import { WorkspaceMembershipService } from '../../src/auth/workspace-membership.service';
import { book, rate } from '../unit/pricing-fixtures';
const workspace='default-workspace',actor={id:'dashboard',workspace_id:workspace,role:'admin' as const,global_admin:true},base='/api/dashboard/pricing';
describe('admission simulation response identity and readonly scope',()=>{
 let h:E2EHarness,db:DataSource,prices:PricingRepository;
 const input=()=>({target:{model:'synthetic-model',node_id:'mock-openai',operation:'chat_completions'},context:{attempt_dispatched_at:'2026-09-27T12:00:00Z'},attempts:4,evidence:[{dimension:'uncached_input_tokens',value:'10',source:'heuristic',quality:'estimated'},{dimension:'output_tokens',value:'20',source:'heuristic',quality:'estimated'}]});
 beforeEach(async()=>{h=await createE2EHarness();await h.app.get(PricingRecoveryService).onModuleDestroy();db=h.app.get(DataSource);await applyPricingSchema(db);prices=h.app.get(PricingRepository);const created=await prices.createBook(actor,{name:'Synthetic admission preview',scope:'workspace',content:book([rate('input','uncached_input_tokens','0.01','1'),rate('output','output_tokens','0.02','1')])});await prices.publishDraft(actor,created.draft.id,{draft_revision:1,catalog_revision:0,reason:'Synthetic',confirm:true,targets:[{level:'model',model:'synthetic-model'}]})});
 afterEach(async()=>{await h?.close()});
 const snapshot=async()=>{const out:Record<string,unknown>={};for(const table of [...PRICING_TABLE_NAMES,'budget_rules'])out[table]=await db.query(`SELECT * FROM ${table}`);return out};
 it('binds response to workspace, exact submitted scenario, selected target and read timestamp without writes',async()=>{
  const body=input(),before=await snapshot(),reply=await h.agent.post(base+'/admission-preview').send(body);expect(reply.status).toBe(201);const{response_hash,...payload}=reply.body;expect(response_hash).toBe(pricingContentHash(payload));expect(reply.body.request_hash).toBe(pricingContentHash(body));expect(reply.body.workspace_id).toBe(workspace);expect(reply.body.target).toEqual(body.target);expect(Number.isFinite(Date.parse(reply.body.evaluated_at))).toBe(true);expect(reply.body.assessment).toMatchObject({allowed:true,policy_source:'catalog',reserved_cost_usd:'2.000000000000000000'});expect(await snapshot()).toEqual(before);expect(h.fetchMock.calls).toHaveLength(0);
 });
 it('keeps proposals separate and returns conditional bounds without changing the active policy',async()=>{
  const body={...input(),policy:{mode:'reserve_upper_bound',quantity_limits:{total_input_tokens:'100',output_tokens:'40'},limit_reference:'Synthetic contract'}},before=await snapshot();const reply=await h.agent.post(base+'/admission-preview').send(body);expect(reply.status).toBe(201);expect(reply.body.assessment).toMatchObject({allowed:true,policy_source:'simulation_override',reserved_cost_usd:'7.200000000000000000',guarantee:'conditional_on_declared_limits',policy_hash:pricingContentHash(body.policy)});expect(reply.body.assessment.quantity_bounds.uncached_input_tokens).toMatchObject({value:'100',basis:'parent_quantity_limit',parent:'total_input_tokens'});expect(await snapshot()).toEqual(before);expect(h.fetchMock.calls).toHaveLength(0);
 });
 it('returns an explicit budget basis bound to the scenario while preserving omitted legacy policy hashes',async()=>{
  const before=await snapshot(),body={...input(),policy:{mode:'compatibility',budget_basis:'actual_upstream'}};
  const actual=await h.agent.post(base+'/admission-preview').send(body);expect(actual.status).toBe(201);expect(actual.body.assessment).toMatchObject({budget_basis:'actual_upstream',policy_hash:pricingContentHash(body.policy),reserved_cost_usd:'2.000000000000000000'});
  const legacyPolicy={mode:'compatibility'};const legacy=await h.agent.post(base+'/admission-preview').send({...body,policy:legacyPolicy});expect(legacy.status).toBe(201);expect(legacy.body.assessment).not.toHaveProperty('budget_basis');expect(legacy.body.assessment.policy_hash).toBe(pricingContentHash(legacyPolicy));expect(await snapshot()).toEqual(before);expect(h.fetchMock.calls).toHaveLength(0);
 });
 it('reports the published basis and previews restoration of a whole policy without changing current admissions',async()=>{
  const policy={mode:'compatibility' as const,budget_basis:'actual_upstream' as const};
  await prices.updateAdmissionPolicy(actor,{catalog_revision:1,scope:'global',operation:'chat_completions',policy,reason:'Synthetic global actual policy',confirm:true});
  const published=await h.agent.post(base+'/admission-preview').send(input());expect(published.body.assessment).toMatchObject({budget_basis:'actual_upstream',policy_source:'catalog'});
  await prices.updateAdmissionPolicy(actor,{catalog_revision:2,scope:'workspace',policy:{mode:'compatibility'},reason:'Synthetic whole workspace policy',confirm:true});
  const overridden=await h.agent.post(base+'/admission-preview').send(input());expect(overridden.body.assessment).not.toHaveProperty('budget_basis');
  const before=await snapshot();const preview=await h.agent.post(base+'/admission-policy/preview').send({catalog_revision:3,scope:'workspace',policy:null,reason:'Synthetic inherited basis preview',confirm:true});expect(preview.status).toBe(201);expect(preview.body).toMatchObject({before:{mode:'compatibility'},after:null});expect(await snapshot()).toEqual(before);
  await prices.updateAdmissionPolicy(actor,{catalog_revision:3,scope:'workspace',policy:null,reason:'Synthetic restore whole policy inheritance',confirm:true});
  const inherited=await h.agent.post(base+'/admission-preview').send(input());expect(inherited.body.assessment).toMatchObject({budget_basis:'actual_upstream',policy_hash:pricingContentHash(policy)});expect(h.fetchMock.calls).toHaveLength(0);
 });
 it('lets a viewer simulate only its workspace catalog and never reveals another scope price',async()=>{
  const other=await h.app.get(WorkspaceService).createWorkspace({name:'Other simulation workspace'});await h.app.get(WorkspaceMembershipService).ensureMembership({userId:'dashboard',workspaceId:other.id,organizationId:other.organization_id,role:'viewer'});const before=await snapshot(),body={...input(),policy:{mode:'reject_unpriced'}};const reply=await h.agent.post(base+'/admission-preview').set('x-siftgate-workspace-id',other.id).send(body);expect(reply.status).toBe(201);expect(reply.body.workspace_id).toBe(other.id);expect(reply.body.cost).toMatchObject({book_id:null,version_id:null,report_amount:null});expect(reply.body.assessment).toMatchObject({allowed:false,reserved_cost_usd:null});expect(await snapshot()).toEqual(before);
 });
});
