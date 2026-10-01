import { legacyReportMoney, sumCostReportMoney } from '../../src/pricing/cost-report-money';
import { DataSource } from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CallLog } from '../../src/database/entities/call-log.entity';
import { BudgetRule } from '../../src/database/entities/budget-rule.entity';
import { BudgetService } from '../../src/budget/budget.service';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import { DEFAULT_WORKSPACE_ID as workspace } from '../../src/workspaces/workspace.constants';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { CostReportService } from '../../src/pricing/cost-report.service';
import { costReportTotals } from '../../src/pricing/cost-report-projection';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { applyPricingSchema, PRICING_TABLE_NAMES, PRICING_SCHEMA_VERSION } from '../../src/pricing/pricing-schema';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import { tokenBook, tokens } from './pricing-fixtures';
import { mockConfigService } from '../helpers';
import type { CostReportRow } from '../../src/pricing/cost-report.types';
import type { CostComputation } from '../../src/pricing/pricing.types';

function contract(name: string, connect: () => Promise<{ source: DataSource; cleanup: () => Promise<void> }>, run = describe) {
  run(name, () => {
    let source: DataSource, cleanup: () => Promise<void>, ledger: CostLedgerService, reports: CostReportService, prices: PricingRepository;
    const actor = { id: 'reader', workspace_id: workspace, role: 'viewer' as const, global_admin: false }, admin = { ...actor, role: 'admin' as const, global_admin: true };
    const window = () => ({ from: new Date(Date.now()-86400000).toISOString(), to: new Date(Date.now()+86400000).toISOString() });
    beforeEach(async()=>{({source,cleanup}=await connect());ledger=new CostLedgerService(source,new BudgetService(mockConfigService(),new WorkspaceContextService(),source.getRepository(BudgetRule)));reports=new CostReportService(source,ledger);prices=new PricingRepository(source)});
    afterEach(async()=>{jest.restoreAllMocks();if(source?.isInitialized)await source.destroy();await cleanup?.()});
    async function initialize(){await applyPricingSchema(source);const created=await prices.createBook(admin,{name:'Synthetic report price',scope:'workspace',content:tokenBook()});await prices.publishDraft(admin,created.draft.id,{draft_revision:1,catalog_revision:0,reason:'Synthetic',confirm:true,targets:[{level:'model',model:'synthetic-model'}]})}
    async function log(request: string, scoped: string|null = workspace, cost = 999){const repo=source.getRepository(CallLog);return repo.save(repo.create({request_id:request,workspace_id:scoped,source_format:'chat_completions',model:'synthetic-model',node_id:'n',tier:'standard',score:0,cost_usd:cost,error:'PRIVATE-MESSAGE'}))}
    async function attempt(request: string, kind: 'priced'|'pending'|'missing_usage'|'estimated'|'free'|'partial'|'unpriced'|'legacy_estimate'='priced', withLog=true) {
      const snapshot=await prices.capture({request_id:request,workspace_id:workspace,report_currency:'USD'}); const cost=snapshot!.quote({node_id:'n',model:'synthetic-model'},tokens({input_tokens:1000,output_tokens:0})).cost;
      const usage=kind==='missing_usage'?{...cost.usage,quantities:{}}:cost.usage;
      const adjusted:CostComputation={...cost,usage,status:kind==='pending'?'priced':kind,...(['missing_usage','partial','unpriced'].includes(kind)?{amount:null,report_amount:null,known_subtotal:kind==='partial'?'0.0001':null,report_known_subtotal:kind==='partial'?'0.0001':null}:{}),...(kind==='free'?{amount:'0',report_amount:'0',known_subtotal:'0',report_known_subtotal:'0',lines:[]}:{}),...(['missing_usage','unpriced'].includes(kind)?{lines:[]}:{})};
      await ledger.beginAttempt({id:`a-${request}`,requestId:request,workspace,target:{node_id:'n',model:'synthetic-model'},feeSource:kind==='free'?'local_cache':'provider',dispatchedAt:new Date().toISOString(),priceContext:{context:{},legacyPrice:null}});
      if(kind!=='pending')await ledger.completeAttempt(`a-${request}`,workspace,adjusted);
      const entry=withLog?await log(request):null;return {cost:adjusted,log:entry};
    }
    async function allRows(limit=2){const query={...window(),limit:String(limit)},rows:CostReportRow[]=[];let cursor:string|undefined;let pages=0;do{const page=await reports.page(actor,{...query,...(cursor?{cursor}:{})});rows.push(...page.rows);cursor=page.next_cursor??undefined;if(++pages>50)throw Error('loop')}while(cursor);return rows}
    const dump=async()=>{const values:Record<string,unknown>={};for(const table of [...PRICING_TABLE_NAMES,'call_logs','budget_rules'])values[table]=await source.query(`SELECT * FROM ${table}`);return values};
    it('reports legacy/null-workspace rows without creating or migrating pricing tables',async()=>{
      const a=await log('legacy',null,.125);await log('other','other-workspace',1);
      const page=await reports.page(actor,{...window(),limit:'20'});expect(page.schema_available).toBe(false);expect(page.rows).toHaveLength(1);expect(page.rows[0]).toMatchObject({log_id:a.id,basis:'legacy_log',status:'legacy_estimate',amount_usd:null,legacy_estimate_usd:'0.125000000000000000'});expect(page.totals).toMatchObject({legacy_requests:1,unknown_amount_requests:1,calculated_requests:0});
      const runner=source.createQueryRunner();try{expect(await runner.hasTable('pricing_schema_versions')).toBe(false)}finally{await runner.release()}
      expect((await reports.page({...actor,workspace_id:'other-workspace'},window())).rows).toHaveLength(1);
    });
    it('combines priced, unknown, pending, estimated, free, legacy and missing-log requests without double counting',async()=>{
      await initialize();for(const kind of ['priced','missing_usage','pending','estimated','free','partial','unpriced','legacy_estimate'] as const)await attempt(kind,kind,kind!=='pending');await log('old-only',null,.12);await prices.capture({request_id:'no-attempt',workspace_id:workspace,report_currency:'USD'});
      const before=await dump(),rows=await allRows();expect(rows).toHaveLength(10);expect(new Set(rows.map(r=>r.request_id)).size).toBe(10);expect(rows.find(r=>r.request_id==='no-attempt')).toMatchObject({basis:'missing_evidence',status:'unpriced',amount_usd:null});expect(rows.find(r=>r.request_id==='pending')).toMatchObject({log_id:null,status:'pending',amount_usd:null});expect(rows.find(r=>r.request_id==='missing_usage')?.status).toBe('missing_usage');expect(rows.find(r=>r.request_id==='free')).toMatchObject({local_cache:true,amount_usd:'0.000000000000000000',status:'free'});
      const totals=costReportTotals(rows);expect(totals).toMatchObject({requests:10,calculated_requests:2,known_amount_requests:4,unknown_amount_requests:6,legacy_requests:1,missing_log_requests:2,legacy_estimate_usd:'0.120000000000000000',partial_known_usd:'0.000100000000000000'});expect(await dump()).toEqual(before);expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|error_code|cost_json|headers/);
    });
    it('returns complete same-page compact amounts from original receipts rather than numeric log projections',async()=>{
      await initialize();const a=await attempt('known');const out=await reports.logSummaries(actor,{ids:`${a.log!.id},999999`});expect(out.rows[0]).toMatchObject({basis:'immutable_ledger',status:'priced',amount_usd: (await ledger.summary('known',workspace))!.amount});expect(out.rows[0].legacy_estimate_usd).toBeNull();expect(out.unavailable_log_ids).toEqual([999999]);expect(out.rows[0].amount_usd).not.toBe('999.000000000000000000');
    });
    it('includes latest linked correction exactly once and does not use current price publications',async()=>{
      await initialize();const a=await attempt('corrected');const amended={...a.cost,amount:'9007199254740993.000000001',report_amount:'9007199254740993.000000001',known_subtotal:'9007199254740993.000000001',report_known_subtotal:'9007199254740993.000000001'};await ledger.adjustAttempt({id:'correction',attemptId:'a-corrected',workspace,expectedCostHash:pricingContentHash(a.cost),cost:amended,reason:'Synthetic correction',actorId:'a',source:'reconciliation'});
      const rows=await allRows();expect(rows[0].amount_usd).toBe('9007199254740993.000000001000000000');expect(costReportTotals(rows).calculated_usd).toBe('9007199254740993.000000001000000000');
    });
    it('exposes corrupt receipt and snapshot evidence as unknown rather than silently using legacy numeric amounts',async()=>{
      await initialize();const a=await attempt('bad-cost');await source.createQueryBuilder().update('pricing_attempts').set({cost_hash:'broken'}).where('id = :id',{id:'a-bad-cost'}).execute();await attempt('bad-snapshot');await source.createQueryBuilder().update('pricing_request_snapshots').set({snapshot_hash:'bad'}).where('request_id = :id',{id:'bad-snapshot'}).execute();
      const rows=await allRows();expect(rows.every(r=>r.basis==='invalid_evidence'&&r.amount_usd===null&&r.legacy_estimate_usd===null)).toBe(true);expect((await reports.logSummaries(actor,{ids:String(a.log!.id)})).rows[0].basis).toBe('invalid_evidence');
    });
    it('preserves cursor workspace/window/size and excludes new request admissions after its upper bound',async()=>{
      await initialize();await attempt('a');await attempt('b');await log('legacy');const q={...window(),limit:'1'},first=await reports.page(actor,q);await attempt('c');await log('new-legacy');const rows=[...first.rows];let cursor=first.next_cursor;while(cursor){const page=await reports.page(actor,{...q,cursor});rows.push(...page.rows);cursor=page.next_cursor}
      expect(rows.map(r=>r.request_id).sort()).toEqual(['a','b','legacy']);
      await expect(reports.page({...actor,workspace_id:'other'},{...q,cursor:first.next_cursor})).rejects.toMatchObject({status:400});await expect(reports.page(actor,{...q,limit:'2',cursor:first.next_cursor})).rejects.toMatchObject({status:400});await expect(reports.page(actor,{...q,to:new Date(Date.now()+1000).toISOString(),cursor:first.next_cursor})).rejects.toMatchObject({status:400});
    });
    it('classifies non-object snapshot JSON as invalid evidence without hiding other requests',async()=>{
      await initialize();await attempt('good-shape');for(const [index,value] of [null,[], 'invalid'].entries()){const id=`bad-shape-${index}`;await attempt(id);await source.createQueryBuilder().update('pricing_request_snapshots').set({descriptor_json:JSON.stringify(value)}).where('request_id = :id',{id}).execute()}
      const rows=await allRows();expect(rows.find(row=>row.request_id==='good-shape')?.status).toBe('priced');expect(rows.filter(row=>row.basis==='invalid_evidence')).toHaveLength(3);expect(rows.filter(row=>row.basis==='invalid_evidence').every(row=>row.amount_usd===null&&row.legacy_estimate_usd===null)).toBe(true);
    });
    it('does not duplicate a snapshot cohort when its call log arrives during the scan',async()=>{
      await initialize();await attempt('pending-log','priced',false);await attempt('b');await log('legacy');const q={...window(),limit:'1'},first=await reports.page(actor,q);await log('pending-log');const rows=[...first.rows];let cursor=first.next_cursor;while(cursor){const page=await reports.page(actor,{...q,cursor});rows.push(...page.rows);cursor=page.next_cursor}expect(rows.filter(r=>r.request_id==='pending-log')).toHaveLength(1);
    });
    it('keeps pending logical budget separate from a complete upstream receipt',async()=>{
      await initialize();const snapshot=await prices.capture({request_id:'hold',workspace_id:workspace,report_currency:'USD'}),cost=snapshot!.quote({node_id:'n',model:'synthetic-model'},tokens({input_tokens:1,output_tokens:0})).cost;
      await ledger.reserve({id:'hold-r',requestId:'hold',identity:{workspaceId:workspace,apiKeyId:null,apiKeyName:null,namespaceId:null,teamId:null},target:{node_id:'n',model:'synthetic-model'},estimate:cost,tokens:'1',costUsd:'1',budgetBasis:'test',leaseOwner:'fixture',leaseUntil:new Date(Date.now()+60000).toISOString()});await ledger.beginAttempt({id:'hold-a',requestId:'hold',workspace,reservationId:'hold-r',target:{node_id:'n',model:'synthetic-model'},feeSource:'provider',dispatchedAt:new Date().toISOString(),priceContext:{context:{},legacyPrice:null}});await ledger.completeAttempt('hold-a',workspace,cost);
      const row=(await allRows())[0];expect(row).toMatchObject({pending_financial:true,status:'priced',budget_reserved_usd:'1.000000000000000000'});expect(row.amount_usd).not.toBe(row.budget_reserved_usd);
    });
    it('uses a durable explicit compatibility marker, not missing receipts alone, to preserve legacy estimates',async()=>{
      await initialize();await prices.capture({request_id:'bypass',workspace_id:workspace,report_currency:'USD'});await log('bypass',workspace,2e-8);
      expect((await allRows())[0].basis).toBe('missing_evidence');
      await prices.recordCompatibilityBypass('bypass',workspace,'chat_completions','no_active_bindings');
      const row=(await allRows())[0];expect(row).toMatchObject({basis:'legacy_log',status:'legacy_estimate',legacy_estimate_usd:'0.000000020000000000'});expect(row.snapshot_hash).not.toBeNull();
      await source.query("DELETE FROM pricing_audit_events WHERE action = 'request.pricing_bypassed'");expect((await allRows())[0].basis).toBe('missing_evidence');
    });
    it.each(['pricing-engine-001','pricing-engine-015',PRICING_SCHEMA_VERSION])('refuses missing migration %s instead of declaring existing new requests legacy',async version=>{
      await applyPricingSchema(source);await source.createQueryBuilder().delete().from('pricing_schema_versions').where('id = :version',{version}).execute();await expect(reports.page(actor,window())).rejects.toMatchObject({status:503});
      await expect(new PricingRepository(source).listBooks(actor)).rejects.toMatchObject({code:'pricing_schema_required',status:503});
    });
    it('rejects a changed earlier checksum even when the latest migration marker is valid',async()=>{
      await applyPricingSchema(source);await source.createQueryBuilder().update('pricing_schema_versions').set({checksum:'0'.repeat(64)}).where('id = :id',{id:'pricing-engine-015'}).execute();await expect(reports.page(actor,window())).rejects.toMatchObject({code:'pricing_schema_required',status:503});
      await expect(new PricingRepository(source).listBooks(actor)).rejects.toMatchObject({status:503});
    });
    it('does not let an older runtime silently accept unknown future migration markers',async()=>{
      await applyPricingSchema(source);await source.createQueryBuilder().insert().into('pricing_schema_versions').values({id:'pricing-engine-future',checksum:'0'.repeat(64),applied_at:new Date().toISOString()}).execute();await expect(reports.page(actor,window())).rejects.toMatchObject({status:503});
    });
    it('rejects invalid query, duplicate IDs and unscoped actors without disclosing rows',async()=>{
      await initialize();for(const query of [{...window(),limit:'51'},{...window(),from:'bad'},{...window(),cursor:'!bad'},{...window(),sql:'drop'}])await expect(reports.page(actor,query)).rejects.toThrow();for(const ids of ['1,1','-1','1e3',''])await expect(reports.logSummaries(actor,{ids})).rejects.toThrow();await expect(reports.page({...actor,id:''},window())).rejects.toMatchObject({status:403});
      const hidden=await log('hidden','other-workspace');expect((await reports.logSummaries(actor,{ids:String(hidden.id)})).rows).toEqual([]);
    });
    it('propagates unavailable storage rather than converting it to a successful unknown report',async()=>{
      await initialize();await attempt('a');jest.spyOn(ledger,'reportSummary').mockRejectedValueOnce(new Error('database offline'));await expect(reports.page(actor,window())).rejects.toThrow('database offline');
    });
  });
}
contract('SQLite cost reports',async()=>{const dir=mkdtempSync(join(tmpdir(),'cost-report-'));const source=await new DataSource({type:'better-sqlite3',database:join(dir,'report.db'),entities:[BudgetRule,CallLog],synchronize:true}).initialize();await source.query('PRAGMA journal_mode=WAL');return {source,cleanup:async()=>rmSync(dir,{recursive:true,force:true})}});
const pg=process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;if(pg&&(new URL(pg).hostname!=='127.0.0.1'||!/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pg).pathname)))throw Error('Private test database required');
contract('PostgreSQL cost reports',async()=>{if(!pg)throw Error('No private PG');const schema=`report_${process.pid}_${Math.random().toString(16).slice(2)}`,admin=await new DataSource({type:'postgres',url:pg,synchronize:false}).initialize();await admin.query(`CREATE SCHEMA "${schema}"`);const source=await new DataSource({type:'postgres',url:pg,schema,extra:{options:`-c search_path=${schema}`},entities:[BudgetRule,CallLog],synchronize:true}).initialize();return {source,cleanup:async()=>{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.destroy()}}},pg?describe:describe.skip);

describe('report money boundaries',()=>{
 it('keeps exponent-format legacy amounts without rounding a tiny nonzero value into free',()=>{expect(legacyReportMoney(2e-8)).toBe('0.000000020000000000');expect(legacyReportMoney(1e-20)).toBeNull();expect(legacyReportMoney(1e30)).toBeNull();expect(legacyReportMoney(0)).toBe('0.000000000000000000')});
 it('sums beyond the individual component input bound without float loss',()=>{expect(sumCostReportMoney('999999999999999999999999999999.999999999999999999','0.000000000000000001')).toBe('1000000000000000000000000000000.000000000000000000')});
});
