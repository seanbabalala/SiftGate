import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
export async function checkMediaDisposition({root,moduleFrom,usageForm,attemptForm,hashing}) {
 const form=moduleFrom(path.join(root,'src/lib/media-disposition-form.ts'),{'./usage-recovery-form':usageForm,'./attempt-correction-form':attemptForm})
 const plain=v=>JSON.parse(JSON.stringify(v)), h=hashing.pricingContentHash
 const usage={schema_version:1,adapter_id:'synthetic',adapter_version:'1',quantities:{video_seconds:{dimension:'video_seconds',unit:'second',value:'8.4',quality:'observed',source:'provider_job_result'}},diagnostics:[]}
 const cost={schema_version:1,calculator_version:'1',status:'priced',report_currency:'USD',currency:'USD',amount:'0.860000000',report_amount:'0.860000000',known_subtotal:'0.860000000',report_known_subtotal:'0.860000000',rounding_adjustment:'0',report_rounding_adjustment:'0',lines:[],diagnostics:[],usage,selection:null,selected_rule_ids:[],book_id:'immutable',version_id:'original',content_hash:'f'.repeat(64),fx_version_id:null,evidence_status:'observed'}
 const old={...cost,amount:'0.660000000',report_amount:'0.660000000',known_subtotal:'0.660000000',report_known_subtotal:'0.660000000'}
 const budget={budget_state:'applied_cost_only',budget_cost_before:'0.66',budget_cost_after:'0.86',budget_tokens_before:'0',budget_tokens_after:'0',cost_delta:'0.20',tokens_delta:'0',allocations:[{ruleId:1,workspaceId:'w',periodStart:'2026-09-27T00:00:00Z',type:'daily_cost',amount:'0.20'}],current_period_refund_not_guaranteed:true}
 const basis={task_id:'task',event_id:'event',event_hash:'e'.repeat(64),basis_hash:'b'.repeat(64),workspace_id:'w',request_id:'request',origin:'authenticated_connector',sequence:'900719925474099312345',effective_sequence:'900719925474099312345',authority:null,current_cost:old,current_cost_hash:h(old),reservation_state:'committed',blocked_reason:null,accept_blocked_reason:null,disposition:null}
 const preview={task_id:'task',request_id:'request',event_id:'event',event_hash:basis.event_hash,basis_hash:basis.basis_hash,action:'accept',ordering:'continue_ordered',next_sequence:basis.sequence,source_id:'source',observation:{provider_job_id:'job',credential_id:'original',status:'completed',usage,context:{time_estimated:true},error_code:null},previous_cost:old,previous_cost_hash:h(old),cost,cost_hash:h(cost),impact:{operation:'adjustment',amount_delta:'0.200000000000000000',currency:'USD',budget,original_reservation_id:'reservation',processing_deferred:true},preview_hash:'',dry_run:true,supplier_invoice_confirmed:false,original_receipts_modified:false}
 const seal=p=>{const {preview_hash:_hash,...body}=p;return {...p,preview_hash:h(body)}}
 const reviewed=seal(preview), selected=form.mediaDispositionChoice(basis,'accept','continue_ordered')
 await form.verifyMediaDispositionBasis(basis,'w','task','event');await form.verifyMediaDispositionPreview(reviewed,'w','task','event',selected)
 for(const patch of [{workspace_id:'other'},{event_id:'other'},{current_cost_hash:'f'.repeat(64)},{effective_sequence:123},{blocked_reason:'unknown'}])await assert.rejects(form.verifyMediaDispositionBasis({...basis,...patch},'w','task','event'))
 assert.throws(()=>form.mediaDispositionChoice({...basis,sequence:null},'accept','continue_ordered'))
 assert.throws(()=>form.mediaDispositionChoice(basis,'accept',''))
 assert.throws(()=>form.mediaDispositionChoice({...basis,accept_blocked_reason:'pending_processing'},'accept','manual_review'))
 assert.equal(form.mediaDispositionChoice({...basis,accept_blocked_reason:'pending_processing'},'reject','unchanged').action,'reject')
 for(const patch of [{dry_run:false},{task_id:'other'},{event_id:'other'},{preview_hash:'f'.repeat(64)},{action:'reject'},{supplier_invoice_confirmed:true},{cost_hash:'f'.repeat(64)}])await assert.rejects(form.verifyMediaDispositionPreview({...reviewed,...patch},'w','task','event',selected))
 for(const patch of [{impact:{...preview.impact,amount_delta:'0.21'}},{impact:{...preview.impact,budget:{...budget,allocations:[{...budget.allocations[0],workspaceId:'other'}]}}},{observation:{...preview.observation,usage:{...usage,quantities:{}}}},{impact:{...preview.impact,processing_deferred:false}}])await assert.rejects(form.verifyMediaDispositionPreview(seal({...preview,...patch}),'w','task','event',selected))
 const unknown=seal({...preview,cost:{...cost,status:'partial',report_amount:null,amount:null},cost_hash:h({...cost,status:'partial',report_amount:null,amount:null}),impact:{...preview.impact,amount_delta:null,budget:{...budget,budget_state:'pending',budget_cost_after:'0.66',cost_delta:'0',allocations:[]}}})
 await form.verifyMediaDispositionPreview(unknown,'w','task','event',selected)
 const rejected=seal({...preview,action:'reject',ordering:'unchanged',cost:old,cost_hash:h(old),impact:{...preview.impact,operation:'none',amount_delta:'0',budget:null}})
 await form.verifyMediaDispositionPreview(rejected,'w','task','event')
 const initial=seal({...preview,previous_cost:null,previous_cost_hash:null,impact:{...preview.impact,operation:'initial',amount_delta:null,budget:null}})
 await form.verifyMediaDispositionPreview(initial,'w','task','event')
 const input=form.mediaDispositionProposal(reviewed,'  Reviewed synthetic evidence  ')
 assert.equal(input.reason,'Reviewed synthetic evidence');assert.equal(input.expected_preview_hash,reviewed.preview_hash)
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)}
 form.saveMediaDisposition(storage,{version:1,workspace:'w',actor:'admin',task:'task',event:'event',proposal:{...input,raw_response:'PRIVATE'}})
 const saved=form.loadMediaDisposition(storage,'w','admin','task','event');assert.deepEqual(plain(saved.proposal),plain(input))
 assert.ok(![...values.values()][0].includes('PRIVATE'))
 for(const tuple of [['other','admin','task','event'],['w','other','task','event'],['w','admin','other','event'],['w','admin','task','other']])assert.equal(form.loadMediaDisposition(storage,...tuple),null)
 const receipt={id:input.id,task_id:'task',event_id:'event',actor_id:'admin',observation_id:'observation',record_hash:'a'.repeat(64),preview:reviewed,replayed:true,dry_run:false,processing_pending:true}
 await form.verifyMediaDispositionReceipt(receipt,'w','admin','task','event',input)
 for(const patch of [{id:'different'},{actor_id:'other'},{observation_id:null},{processing_pending:'yes'},{preview:{...reviewed,preview_hash:'a'.repeat(64)}}])await assert.rejects(form.verifyMediaDispositionReceipt({...receipt,...patch},'w','admin','task','event',input))
 values.set(form.mediaDispositionPendingKey('w','admin','task','event'),JSON.stringify({...saved,event:'other'}));assert.throws(()=>form.loadMediaDisposition(storage,'w','admin','task','event'))
 for(const locale of ['en','zh','zh-TW','ja','ko','th','es']){const data=JSON.parse(fs.readFileSync(path.join(root,`src/locales/${locale}/pricing.json`)));const keys=Object.keys(data).filter(k=>k.startsWith('mediaDisposition.'));assert.equal(keys.length,41);for(const key of keys)assert.ok(data[key].trim())}
 const page=fs.readFileSync(path.join(root,'src/pages/media-disposition-page.tsx'),'utf8'),editor=fs.readFileSync(path.join(root,'src/components/pricing/media-disposition-editor.tsx'),'utf8')
 assert.ok(!page.includes('description={event}'))
 assert.ok(page.includes('basis.isPending && !restored.pending && !restored.bad'))
 assert.ok(editor.includes("phase === 'uncertain' && canManage"))
 assert.ok(editor.includes("phase !== 'recorded' && !basis && basisError != null"))
 assert.ok(editor.indexOf('saveMediaDisposition(sessionStorage')<editor.indexOf('`${prefix}/disposition`, input'))
 console.log('Media disposition UI contracts passed: scoped durable retry, exact preview and budget hashes, signed ordering, unknown totals, rejection, role-safe recovery and seven locales.')
}
