import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
export async function checkCostReport({root,moduleFrom,usageForm,hashing}){
 const wire=moduleFrom(path.join(root,'../src/pricing/cost-report.types.ts')),money=moduleFrom(path.join(root,'../src/pricing/cost-report-money.ts'))
 const model=moduleFrom(path.join(root,'src/lib/cost-report-model.ts'),{'./usage-recovery-form':usageForm,'../../../src/pricing/cost-report-money':money,'../../../src/pricing/cost-report.types':wire})
 const row={workspace_id:'w',request_id:'r',log_id:1,recorded_at:'2026-09-27T00:00:00Z',source_format:'chat_completions',node_id:'n',model:'m',status:'priced',basis:'immutable_ledger',amount_usd:'9007199254740993.000000001000000000',known_subtotal_usd:'9007199254740993.000000001000000000',legacy_estimate_usd:null,budget_reserved_usd:'0.000000000000000000',budget_committed_usd:'0.000000000000000000',pending_financial:false,unknown_attempts:0,pending_attempts:0,provider_attempts:1,local_cache:false,snapshot_hash:'a'.repeat(64),evidence_hash:'e'.repeat(64)}
 const window={from:'2026-09-27T00:00:00.000Z',to:'2026-09-28T00:00:00.000Z'}
 const unknown={...row,request_id:'unknown',log_id:null,status:'partial',amount_usd:null,known_subtotal_usd:'0.123456789123456789',pending_attempts:1,pending_financial:true}
 const legacy={...row,request_id:'old',log_id:3,status:'legacy_estimate',basis:'legacy_log',amount_usd:null,known_subtotal_usd:null,legacy_estimate_usd:'0.000000020000000000',snapshot_hash:null}
 const totals=model.reportTotalsForRows([row,unknown,legacy]);assert.equal(totals.calculated_usd,row.amount_usd);assert.equal(totals.calculated_requests,1);assert.equal(totals.unknown_amount_requests,2);assert.equal(totals.legacy_estimate_usd,'0.000000020000000000');assert.equal(totals.partial_known_usd,'0.123456789123456789')
 assert.equal(model.mergeCostReportTotals(totals,totals).calculated_usd,'18014398509481986.000000002000000000')
 const base={workspace_id:'w',window,limit:50,schema_available:true,population:'retained_requests_and_legacy_logs',consistency:'page_snapshot_live_between_pages',report_id:'f'.repeat(64),requested_cursor:null,next_cursor:'Y3Vyc29y',scanned_at:'2026-09-27T01:00:00Z',rows:[row,unknown,legacy],totals}
 const seal=p=>({...p,page_hash:hashing.pricingContentHash(p)}),page=seal(base)
 await model.verifyCostReportPage(page,'w',window,null,null)
 for(const patch of [{workspace_id:'other'},{requested_cursor:'wrong'},{report_id:'bad'},{limit:100},{rows:[row,row]},{totals:{...totals,unknown_amount_requests:0}},{rows:[{...row,status:'free'}]},{rows:[{...unknown,amount_usd:'0'}]}])await assert.rejects(model.verifyCostReportPage(seal({...base,...patch}),'w',window,null,null))
 await assert.rejects(model.verifyCostReportPage(page,'w',window,'Y3Vyc29y',page.report_id))
 const second=seal({...base,requested_cursor:'Y3Vyc29y',next_cursor:null});await model.verifyCostReportPage(second,'w',window,'Y3Vyc29y',page.report_id)
 assert.throws(()=>model.verifyLogCostSummaries({workspace_id:'w',rows:[row],unavailable_log_ids:[1],scanned_at:base.scanned_at,read_only:true},'w',[1,2]))
 assert.equal(model.verifyLogCostSummaries({workspace_id:'w',rows:[row],unavailable_log_ids:[2],scanned_at:base.scanned_at,read_only:true},'w',[1,2]).rows.length,1)
 for(const pair of [['2026-02-30T00:00','2026-03-01T00:00'],['2026-09-27T00:00','2026-09-27T00:00'],['2025-01-01T00:00','2026-09-27T00:00']])assert.throws(()=>model.reportWindowFromInputs(...pair))
 assert.equal(model.reportWindowFromInputs('2026-09-27T00:00','2026-09-28T00:00').from,window.from)
 for(const locale of ['en','zh','zh-TW','ja','ko','th','es']) {
  const expected = new Date(window.from).toLocaleString(locale, {timeZone:'UTC'}) + ' UTC'
  assert.equal(model.formatReportTimestamp(window.from,locale),expected)
 }
 assert.equal(model.formatReportTimestamp(window.from,'en'), '9/27/2026, 12:00:00 AM UTC')
 const pageCode=fs.readFileSync(path.join(root,'src/pages/cost-report-page.tsx'),'utf8');assert.ok(pageCode.includes('continueAll ? 200 : 1'));assert.ok(pageCode.includes('verifyCostReportPage(page'));assert.ok(pageCode.includes('page.next_cursor === null'));assert.ok(pageCode.includes('active.current?.abort()'));assert.ok(pageCode.includes("report.windowUsed"));
 for(const locale of ['en','zh','zh-TW','ja','ko','th','es']){const strings=JSON.parse(fs.readFileSync(path.join(root,`src/locales/${locale}/pricing.json`)));for(const key of ['title','coverage','unknown','scopeHelp','consistency','calculated_usd','estimated_usd','legacy_estimate_usd','partial_known_usd','compatibilityHelp'])assert.ok(strings['report.'+key])}
 console.log('Cost report UI contracts passed: exact sums, unknown/legacy separation, scoped hash-verified pages, continuation binding, UTC windows and bounded scans.')
}
