import { DataSource } from 'typeorm';
import { createE2EHarness, E2EHarness } from './setup';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { CallLog } from '../../src/database/entities/call-log.entity';
import { WorkspaceMembershipService } from '../../src/auth/workspace-membership.service';
import { WorkspaceService } from '../../src/workspaces/workspace.service';
import { tokenBook, tokens } from '../unit/pricing-fixtures';
import { DEFAULT_WORKSPACE_ID as workspace } from '../../src/workspaces/workspace.constants';
const actor={id:'dashboard',workspace_id:workspace,role:'admin' as const,global_admin:true};
describe('scoped cost reporting HTTP',()=>{
 let h:E2EHarness,db:DataSource,prices:PricingRepository,ledger:CostLedgerService;
 const path='/api/dashboard/pricing',window=()=>({from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+10000).toISOString()});
 beforeEach(async()=>{h=await createE2EHarness();await h.app.get(PricingRecoveryService).onModuleDestroy();db=h.app.get(DataSource);await applyPricingSchema(db);prices=h.app.get(PricingRepository);ledger=h.app.get(CostLedgerService);const created=await prices.createBook(actor,{name:'Synthetic report rates',scope:'workspace',content:tokenBook()});await prices.publishDraft(actor,created.draft.id,{draft_revision:1,catalog_revision:0,reason:'Synthetic',confirm:true,targets:[{level:'model',model:'m'}]})});
 afterEach(async()=>{jest.restoreAllMocks();await h?.close()});
 async function seed(id:string,terminal=true,withLog=true){const snap=await prices.capture({request_id:id,workspace_id:workspace,report_currency:'USD'}),cost=snap!.quote({model:'m',node_id:'n'},tokens({input_tokens:1000,output_tokens:0})).cost;await ledger.beginAttempt({id:'a-'+id,requestId:id,workspace,target:{model:'m',node_id:'n'},feeSource:'provider',dispatchedAt:new Date().toISOString(),priceContext:{context:{},legacyPrice:null}});if(terminal)await ledger.completeAttempt('a-'+id,workspace,cost);if(withLog)return db.getRepository(CallLog).save({request_id:id,workspace_id:workspace,source_format:'chat_completions',model:'m',node_id:'n',tier:'standard',score:0,cost_usd:99});return null}
 it('scans mixed traffic with stable cursors, complete statuses and no provider calls or writes',async()=>{
  const known=await seed('priced');await seed('pending',false,false);await db.getRepository(CallLog).save({request_id:'legacy',workspace_id:null,source_format:'chat_completions',model:'old',node_id:'old',tier:'standard',score:0,cost_usd:0.5});const q={...window(),limit:'1'};const before=await db.query('SELECT * FROM pricing_audit_events'),requests:string[]=[];let cursor:string|undefined;
  do{const res=await h.agent.get(path+'/cost-report').query({...q,...(cursor?{cursor}:{})});expect({status:res.status,error:res.body.error}).toEqual({status:200,error:undefined});requests.push(...res.body.rows.map((r:{request_id:string})=>r.request_id));cursor=res.body.next_cursor??undefined}while(cursor);expect(requests.sort()).toEqual(['legacy','pending','priced']);expect(await db.query('SELECT * FROM pricing_audit_events')).toEqual(before);expect(h.fetchMock.calls).toHaveLength(0);
  const compact=await h.agent.get(path+'/log-cost-summaries').query({ids:String(known!.id)});expect(compact.status).toBe(200);expect(compact.body.rows[0]).toMatchObject({status:'priced',legacy_estimate_usd:null});expect(compact.body.rows[0].amount_usd).not.toBe('99.000000000000000000');
 });
 it('never disguises a captured request missing its receipt as a legacy/free amount',async()=>{
  await prices.capture({request_id:'lost',workspace_id:workspace,report_currency:'USD'});const log=await db.getRepository(CallLog).save({request_id:'lost',workspace_id:workspace,source_format:'chat_completions',model:'m',node_id:'n',tier:'standard',score:0,cost_usd:0});const response=await h.agent.get(`/api/dashboard/logs/${log.id}/cost-breakdown`);expect(response.status).toBe(200);expect(response.body).toMatchObject({status:'unpriced',amount:null,replayable:false});
 });
 it('permits workspace viewers but never crosses workspace boundaries or reuses cursors across scopes',async()=>{
  const log=await seed('private');await seed('b');const original=await h.agent.get(path+'/cost-report').query({...window(),limit:'1'});const ws=await h.app.get(WorkspaceService).createWorkspace({name:'Other report workspace'});await h.app.get(WorkspaceMembershipService).ensureMembership({userId:'dashboard',workspaceId:ws.id,organizationId:ws.organization_id,role:'viewer'});const compact=await h.agent.get(path+'/log-cost-summaries').set('x-siftgate-workspace-id',ws.id).query({ids:String(log!.id)});expect(compact.status).toBe(200);expect(compact.body.rows).toEqual([]);expect((await h.agent.get(path+'/cost-report').set('x-siftgate-workspace-id',ws.id).query({...original.body.window,limit:'1',cursor:original.body.next_cursor})).status).toBe(400);
 });
 it('returns typed HTTP 400 for invalid periods, cursor syntax, fields and ID sets',async()=>{
  for(const q of [{...window(),limit:'51'},{...window(),cursor:'bad!'},{...window(),from:'2026-02-30T00:00:00Z'},{...window(),sql:'x'}])expect((await h.agent.get(path+'/cost-report').query(q)).status).toBe(400);
  for(const ids of ['1,1','-1','1e4',''])expect((await h.agent.get(path+'/log-cost-summaries').query({ids})).status).toBe(400);
 });
 it('reports malformed accounting evidence as unknown and still lists the rest of the period',async()=>{
  await seed('bad');await seed('good');await db.createQueryBuilder().update('pricing_attempts').set({cost_hash:'broken'}).where('id = :id',{id:'a-bad'}).execute();const res=await h.agent.get(path+'/cost-report').query(window());expect(res.status).toBe(200);expect(res.body.rows.find((r:{request_id:string})=>r.request_id==='bad')).toMatchObject({basis:'invalid_evidence',amount_usd:null});expect(res.body.totals).toMatchObject({calculated_requests:1,unknown_amount_requests:1});
 });
});
