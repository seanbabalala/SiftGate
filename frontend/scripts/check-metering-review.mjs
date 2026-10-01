import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
export async function checkMeteringReview({root,moduleFrom,usageForm,hashing}) {
 const types=moduleFrom(path.join(root,'../src/pricing/pricing-metering.types.ts')),wire=moduleFrom(path.join(root,'../src/pricing/pricing.types.ts')),admission=moduleFrom(path.join(root,'../src/pricing/pricing-admission.types.ts'))
 const specTypes=moduleFrom(path.join(root,'../src/pricing/media-specification.types.ts')),videoProfiles=moduleFrom(path.join(root,'../src/pricing/video-result-profile.types.ts'))
 const inventory=moduleFrom(path.join(root,'../src/pricing/pricing-metering.ts'),{'./pricing-admission.types':admission,'./pricing-json':hashing,'./media-specification.types':specTypes,'./video-result-profile.types':videoProfiles})
 const form=moduleFrom(path.join(root,'src/lib/pricing-metering-review.ts'),{'./usage-recovery-form':usageForm,'../../../src/pricing/pricing-metering.types':types,'../../../src/pricing/pricing.types':wire,'../../../src/pricing/media-specification.types':specTypes,'../../../src/pricing/video-result-profile.types':videoProfiles})
 const content={schema_version:1,currency:'USD',money_precision:9,money_rounding:'half_even',source:{kind:'manual'},billing_dimensions:['video_seconds'],allow_combined_media:false,groups:[]}
 const targets=[{level:'node',model:'synthetic',node_id:'n',operation:'video_generation'}]
 const review=inventory.assessPricingMetering(content,targets,()=> 'runway-task-v1')
 await form.verifyMeteringReview(review,review.content_hash,targets)
 assert.equal(review.targets[0].dimensions[0].availability,'manual_only');assert.equal(review.supplier_support_verified,false);assert.equal(review.quantity_limits_verified,false)
 const seal=value=>{const{assessment_hash,...body}=value;return {...body,assessment_hash:hashing.pricingContentHash(body)}}
 const chatTargets=[{...targets[0],operation:'chat_completions'}]
 const chat=inventory.assessPricingMetering({...content,billing_dimensions:['uncached_audio_input_tokens','audio_output_tokens']},chatTargets)
 await form.verifyMeteringReview(chat,chat.content_hash,chatTargets)
 assert.equal(chat.registry_version,'gateway-metering-v5');assert.equal(chat.can_publish,true)
 assert.equal(chat.targets[0].dimensions.every(d=>d.availability==='conditional'),true)
 assert.ok(chat.targets[0].notices.includes('modality_allocation_required'))
 const nativeGemini=inventory.assessPricingMetering({...content,billing_dimensions:['audio_output_tokens']},[{...chatTargets[0],operation:'gemini_generate_content'}])
 assert.equal(nativeGemini.can_publish,false,'An upstream protocol name is not an implemented public Chat ingress')
 const realtimeTargets=[{...targets[0],operation:'realtime'}]
 const realtime=inventory.assessPricingMetering({...content,billing_dimensions:['session_seconds','audio_output_tokens'],allow_combined_media:true},realtimeTargets)
 await form.verifyMeteringReview(realtime,realtime.content_hash,realtimeTargets);assert.equal(realtime.can_publish,true);assert.ok(realtime.targets[0].notices.includes('realtime_session_contract_required'))
 const image=inventory.assessPricingMetering({...content,billing_dimensions:['image_output_tokens']},chatTargets)
 await form.verifyMeteringReview(image,image.content_hash,chatTargets);assert.equal(image.can_publish,true)
 await form.verifyMeteringReview(seal({...review,registry_version:'gateway-metering-v1'}),review.content_hash,targets)
 const older=seal({...review,registry_version:'gateway-metering-v4',targets:review.targets.map(({media_specification,...row})=>row)})
 await form.verifyMeteringReview(older,review.content_hash,targets)
 await assert.rejects(form.verifyMeteringReview(seal({...older,registry_version:'gateway-metering-v5'}),review.content_hash,targets))
 await assert.rejects(form.verifyMeteringReview(seal({...review,targets:[{...review.targets[0],media_specification:{...review.targets[0].media_specification,fixed:{operation:'generation'}}}]}),review.content_hash,targets))
 await assert.rejects(form.verifyMeteringReview(seal({...chat,registry_version:'gateway-metering-v999'}),chat.content_hash,chatTargets))
 for(const bad of [{...review,assessment_hash:'0'.repeat(64)},seal({...review,supplier_support_verified:true}),seal({...review,targets:[]}),seal({...review,targets:[{...review.targets[0],can_publish:false}]}),seal({...review,targets:[{...review.targets[0],notices:['unknown-warning']}]}),seal({...review,targets:[{...review.targets[0],dimensions:[{dimension:'video_seconds',availability:'guaranteed'}]}]})])await assert.rejects(form.verifyMeteringReview(bad,review.content_hash,targets))
 await assert.rejects(form.verifyMeteringReview(review,review.content_hash,[{...targets[0],node_id:'foreign'}]))
 const publish=fs.readFileSync(path.join(root,'src/components/pricing/price-publish-dialog.tsx'),'utf8');assert.ok(publish.includes('metering_assessment_hash: preview.metering.assessment_hash'));assert.ok(publish.includes('!preview.metering.can_publish'));assert.ok(publish.includes('verifyMeteringReview(result.metering'));assert.ok(publish.includes('PriceMeteringReview review={preview.metering}'));assert.ok(publish.includes('if (!publish) setConfirmed(false)'));assert.ok(publish.includes('catch (failure) { setPreview(null); setConfirmed(false);'))
 for(const locale of ['en','zh','zh-TW','ja','ko','th','es']){const strings=JSON.parse(fs.readFileSync(path.join(root,`src/locales/${locale}/pricing.json`)));for(const name of types.METERING_NOTICES)assert.ok(strings['metering.notice.'+name]);for(const name of types.METERING_AVAILABILITIES)assert.ok(strings['metering.availability.'+name]);for(const name of ['title','help','conditional','blocked','invalid'])assert.ok(strings['metering.'+name])}
 console.log('Metering review UI contracts passed: code capability is conditional, native actual seconds require evidence, reviewed hash and target integrity, blocked unsupported publication and seven locales.')
}
